import { addDays, localParts } from "../lib/time.js";
import { esc } from "../notify/telegram.js";
import { needsAction, type WilmaSnapshot } from "../sources/wilma.js";
import { isoWeek } from "./week-plan.js";

// Sunday evening Wilma week summary for the family group (Henri asked
// 2026-10-25): per child the week's messages, bulletins, lesson notes
// (merkinnät) and homework, and next week's exams. Built here from the
// snapshot, never by a model: Wilma text is untrusted, so it is only escaped
// and cut short. Lesson notes carry the teacher's comment and exams what to
// read (Henri, 2026-10-25: the group is him and Anna). Grades never.
//
// Henri's layout: plain bullets, one empty line between items and sections.

const SHORT = ["su", "ma", "ti", "ke", "to", "pe", "la"];
const short = (date: string) => {
  const [, m, d] = date.split("-").map(Number);
  return `${SHORT[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${d}.${m}.`;
};
const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const localDate = (iso?: string | null) => (iso ? localParts(new Date(iso)).date : "");

interface Item {
  key: string;
  date: string;
  html: string;
  action: boolean;
}

/** One Telegram HTML message per child, plus one for messages and bulletins several children got. */
export function wilmaWeek(snap: WilmaSnapshot, today: string): string[] {
  const from = addDays(today, -6);
  const inWeek = (d: string) => d >= from && d <= today;
  const next = (d: string) => d > today && d <= addDays(today, 7);
  const header = (who: string) => `📚 <b>Wilma, ${esc(who)}</b>\nvk ${isoWeek(today)} · ${short(from)} – ${short(today)}`;

  // Messages and bulletins by id, with the children that got them.
  const shared = new Map<string, string[]>();
  const kidItems = (st: WilmaSnapshot["students"][number]) => {
    const msgs: Item[] = st.messages
      .filter((m) => inWeek(localDate(m.sentAt)))
      .map((m) => ({
        key: `m${m.id}`,
        date: localDate(m.sentAt),
        html: `• ${short(localDate(m.sentAt))} <b>${esc(cut(m.subject, 120))}</b>${m.sender ? `\n ${esc(cut(m.sender, 60))}` : ""}`,
        action: needsAction(`${m.subject} ${m.content ?? ""}`),
      }));
    const news: Item[] = st.news
      .filter((n) => inWeek(localDate(n.published)))
      .map((n) => ({
        key: `n${n.id}`,
        date: localDate(n.published),
        html: `• ${short(localDate(n.published))} <b>${esc(cut(n.title, 120))}</b>`,
        action: needsAction(`${n.title} ${n.content ?? ""}`),
      }));
    for (const i of [...msgs, ...news]) shared.set(i.key, [...(shared.get(i.key) ?? []), st.name]);
    return { msgs, news };
  };
  const perKid = snap.students.map((st) => ({ st, ...kidItems(st) }));
  const isShared = (i: Item) => (shared.get(i.key)?.length ?? 0) > 1;
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);

  const render = (sections: [string, string[]][]) =>
    sections.filter(([, items]) => items.length).map(([title, items]) => `${title}\n\n${items.join("\n\n")}`);
  const mailSections = (msgs: Item[], news: Item[]): [string, string[]][] => [
    ["⚠️ <b>Vaatii toimia</b>", [...msgs, ...news].filter((i) => i.action).sort(byDate).map((i) => i.html)],
    ["✉️ <b>Viestit</b>", msgs.filter((i) => !i.action).sort(byDate).map((i) => i.html)],
    ["📌 <b>Tiedotteet</b>", news.filter((i) => !i.action).sort(byDate).map((i) => i.html)],
  ];

  const out: string[] = [];
  for (const { st, msgs, news } of perKid) {
    const notes = st.notes.filter((n) => inWeek(n.date)).sort(byDate);
    const homework = st.homework.filter((h) => inWeek(h.date)).sort(byDate);
    const exams = st.exams.filter((x) => next(x.date)).sort(byDate);
    const body = render([
      ...mailSections(msgs.filter((i) => !isShared(i)), news.filter((i) => !isShared(i))),
      ["🏷 <b>Merkinnät</b>", notes.slice(0, 20).map((n) => `• ${short(n.date)} ${esc(cut(n.type, 60))}\n ${esc(cut(n.subject, 60))}${n.note ? `\n “${esc(cut(n.note, 200))}”` : ""}`)],
      ["📖 <b>Läksyt</b>", homework.slice(0, 15).map((h) => `• ${short(h.date)} <b>${esc(cut(h.subject, 60))}</b>\n ${esc(cut(h.text, 160))}`)],
      [
        "📝 <b>Kokeet ensi viikolla</b>",
        exams.map((x) =>
          [
            `• ${short(x.date)} <b>${esc(cut(x.subject || x.name, 60))}</b>`,
            x.name && x.name !== x.subject && !/^(koe|exam)$/i.test(x.name) ? ` ${esc(cut(x.name, 80))}` : "",
            x.topic ? ` ${esc(cut(x.topic, 120))}` : "",
            x.notes ? ` 📖 ${esc(cut(x.notes, 200))}` : "",
          ].filter(Boolean).join("\n"),
        ),
      ],
    ]);
    out.push([header(st.name), ...(body.length ? body : ["Ei uutta Wilmassa tällä viikolla."])].join("\n\n"));
  }

  // Items several children got: once, in their own message.
  const seen = new Set<string>();
  const common = (pick: (k: (typeof perKid)[number]) => Item[]) =>
    perKid.flatMap(pick).filter((i) => isShared(i) && !seen.has(i.key) && seen.add(i.key));
  const cMsgs = common((k) => k.msgs);
  const cNews = common((k) => k.news);
  if (cMsgs.length || cNews.length) {
    const names = [...new Set([...cMsgs, ...cNews].flatMap((i) => shared.get(i.key)!))];
    out.push([header(names.join(" & ")), ...render(mailSections(cMsgs, cNews))].join("\n\n"));
  }
  return out;
}

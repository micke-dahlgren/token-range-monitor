# Token Range Monitor 1.4: design plan

Status: agreed in review (drafts 1–4 of the review page), built in 1.4.0.

## Why a new version

**The weekly headline moved when nothing happened.** 1.3 takes the % used, divides it by every hour since the reset, and assumes that pace for every hour left. Idle hours lower the pace, and the lower pace is then applied to the whole rest of the week.

On 10–11 October the weekly figure sat at 39% from noon to 11:00 the next morning, with no use at all. Over that time the headline went from 34% short (noon) to 11% short, 16h early (22:00), to 9% to spare (11:00). Weekends also count only once they've passed, so a weekday worker with a Monday reset sees "runs out" all week.

**The review kept 1.3's framing.** "At this rate you'll run out this much early" is the right question. A daily budget headline and a main/side project split were tried and dropped, because not everyone has a side project. What has to change is how the number moves over time.

## What 1.4 shows

### Above the prompt

Unchanged in shape and wording:

```
Week 6% to spare, resets in 4d 13h · 5h cut off ~00:09, resets 00:40 · Details
Week runs out Wed ~12:45, 22h early · 5h 55% to spare, resets 15:40 · Details
```

- **Week:** green "X% to spare" or red "runs out <day> ~<time>, <how long> early", computed as in *The weekly projection* below.
- **Uncertainty:** `±N` follows the figure when the self-check says the estimate has typically missed by more than 5 points: `Week 9% to spare ±12`.
- **Fresh install:** until one whole day is on record, the figure is 1.3's hourly one with an `early` tag.
- **5h:** a clock time: "cut off ~00:09" in red, or "N% to spare" in green, followed by "resets HH:MM".
- **Narrow form:** `Week +6% 4d 13h · 5h out 00:09 · Details`.
- **No projects** in this line.

### The weekly card

**Every figure says what its 100% is, and no figure mixes two frames.** The card has two labelled parts:
- **This week:** 100% = your weekly limit.
- **Today:** 100% = today's budget.

The only bridge between them is one sentence giving today's budget in week terms.

1. **Head**, under the label "This week · 100% = your weekly limit": "About 6% left at the reset" (green), or "Runs out Wed ~12:45, 22h before the reset" (red). Below it, what that's based on: "At your pace over the last 7 whole days: 13.5% a day", or "At what you usually use on each of the days left". With a range, it reads "between 3% short and 21% to spare".
2. **The whole week as one bar:** from 0 to 100% of the weekly limit. Solid is used, striped is what your pace adds before the reset. Labels: "39% used", "+55.5% at this pace", "100% · resets Thu 11:00". When the projection passes 100%, the striped part stops at the end and the label says how much more than the limit it would need.
3. **The days of this window,** seven columns on one shared scale, each labelled in % of the weekly limit ("20%", "~13.5%"):
   - past days are solid;
   - today is solid;
   - later days are striped at the pace (or the weekday profile).
   - Today and later days carry an **outline at the daily budget**. Today's column turns red when its use passes it.
4. **Today**, under the label "Today · 100% = today's budget":
   - **Predicted use today: 92.5% of daily budget** (red over 100%).
   - A bar from 0 to 100% of today's budget (it can run past 100%): solid up to what's used (82%), striped up to the prediction (92.5%), and a marker at 100% labelled "day ends 11:00".
   - One small sentence: "Until the day ends, today counts as at least one day at your pace, 92.5% of the budget. Today's budget is what's left of the week divided by the days left: 14.6% of your weekly limit." The first part shows only while today's use is under the pace.
5. A dim line, "1.3 shows: …", for the first release only, so the change can be compared.
6. **Details** holds the 1.3 chart, Last window and the explanations.

The 5-hour card is labelled the same way: "100% = your 5-hour limit".

### The projects card (new)

- **Header:** "This week · 39% used, 61% unused", with a thin stacked bar of the split.
- **Rows:** one per project, in % of the weekly limit, largest first, all in one neutral colour.
- **Other:** an expandable row (see *Other*).
- **Unused:** 100 − % used, drawn with a dashed bar.
- **Total:** "Weekly limit · 100%". The column adds up to 100%.
- **Footer:** "Project names stay on this computer."

### The 5-hour card

- **Head:**
  - "Cut off ~17:36 at this pace" (red), with "64% used since 13:10, 22.6% an hour. It resets at 18:10, 34m after the cut-off.", or
  - "Lasts to the reset at 15:40" (green), with "about 55% to spare".
- **A line from the window's opening to its reset:**
  - solid up to now;
  - neutral stripes for the projection;
  - a red line with the cut-off time in red, when there is one.
  - Labels: opening time, "now HH:MM", "reset HH:MM".

### The models card

Unchanged.

## The numbers

### Days

A day is 24 hours from the weekly reset's time of day, so days line up with the week. Day `k` (0–6) is the current day of this window. A day's use is how far the weekly figure rose in it, read from the readings (`increments` over the day, rises over unwatched gaps included: that's real usage from elsewhere).

### Pace

```
pace  = average of the last 7 whole days, across resets
        (fewer while less is on record; none → fresh-install fallback)
today = max(used today, today's expected use)
        today's expected use = pace, or the weekday profile's value for today
```

The 7 days cross the weekly reset. The reset is arbitrary for pace, and this removes any guessing on the first day of a window. Seven days already include a weekend, so the weekend counts at its real weight.

### The weekly projection

```
left at reset = 100 − ( % now + (today − used today) + Σ later days )
later days    = pace for each whole day left after today,
                or the weekday profile once 14 days are on record (see Rhythm)
```

- **Running out:** below zero, the run-out moment is the first later day where the cumulative sum passes 100%, spread evenly within that day. If it passes during today, the time is "later today".
- **How it moves:** it only changes when you use Claude (above today's expected use), or when a day ends.
- **Using less than your pace today** doesn't move it until the day ends. Then the low day joins the 7-day pace, and one fewer day is left. That's deliberate, so idle hours can't swing it. The predicted-use line on the card says so.

### Daily budget

```
daily budget        = (100 − % at the start of today) ÷ (7 − k)
predicted use today = today ÷ daily budget
```

It changes only at the day boundary.

### Rhythm

- **After 14 days of record,** each later day counts at what's usually used on that weekday: the median of that weekday's days on record, and 0 for a weekday that's never active. A weekend you never work adds nothing.
- **Before that,** the 7-day pace applies to every day.
- **Active day:** at least ¼ of your median day with any use. It's relative to your own days, so it needs no knowledge of the plan, and scales the same on Pro and Max.

### Self-check and range

- At each day boundary, store what the projection said at that moment.
- When the window resets, compare each of those with what was actually left. The typical miss is the median absolute error over the last 4 windows.
- When the typical miss is over 5 points, show `±miss` with the figure.

### Fresh install

With no whole day on record, the headline is 1.3's hourly figure tagged `early`, and the card says why.

### The 5-hour cut-off

`now + (100 − used) ÷ pace`, with the pace since the window opened, as now. It's shown in local clock time. Anything past the reset shows as "lasts to the reset".

### Projects

- **Tagging:** each recorded response (`RangeStep`) gets a 6th element, the project, from `$.session.root()`:
  - the folder's base name;
  - a worktree under `<repo>/.claude/worktrees/<name>` counts as `<repo>`;
  - the desktop app's scratch workspaces (`…/Claude/scratch-workspaces/…`) are tagged as chats.
- **Weighting:** each response weighs its tokens × its model's learned cost, or the mean of the known costs while a model is still learning.
- **The split:** the weekly % that rose while this computer was watching is split by that weighted work. Usage over unwatched gaps goes to Away.

### Other

One row, with this breakdown in the pane and in the README:

- **Desktop chats:** conversations in the desktop app's chat, which run in a temporary folder rather than a project.
- **Other devices:** responses synced from your other computers. Their project names stay there.
- **Before 1.4:** responses recorded before projects were tracked.
- **Away:** usage with no responses seen: claude.ai in a browser, the phone app, or a device without the plugin.

## Privacy and sync

- **Project names never leave the computer:** `packDays` drops the project field before upload. The server, the wire format and the privacy policy are unchanged.
- **Older devices:** `unpack` already ignores fields after the 5th, so devices still on 1.3 keep syncing.
- **Encrypted project sync:** in the backlog. It needs a device-pairing secret the server never sees.

## Data changes

| What | Change | Migration |
|---|---|---|
| `RangeStep` | optional 6th element `project?: string` | old steps count as "Before 1.4" |
| daily totals (new) | one `[dayStart, %]` per day for 8 weeks, local store, rebuilt from the merged readings (synced ones included) | built from readings on first run |
| self-check (new) | per window: the projection at each day boundary and the final outcome, last 4 windows | starts empty; no range until one window completes |
| sync | strip `project` in `packDays` | none |

## Code layout

- **`hooks/pace.ts` (new):** `dayIndex`, `dailyTotals`, `pace`, `activeThreshold`, `weekdayProfile`, `weekPlan` (the projection, daily budget and predicted use), `selfCheck`, `typicalMiss`. Pure functions, with tests.
- **`hooks/cards.ts` (new):** the line above the prompt (`weekPart`, `fivePart`), the cards' words, and their drawings (`weekCardSvg`, `projectsSvg`, `fiveCardSvg`).
- **`hooks/projects.ts` (new):** `projectName(root)`, `projectSplit(...)`, the Other breakdown.
- **`hooks/range.ts`:** unchanged; 1.3's projection stays for the Details chart and the comparison line.
- **`hooks/register.tsx`:**
  - record the project in `turn.step`;
  - keep the daily totals and the self-check;
  - the new weekly card parts;
  - the projects card;
  - the 5-hour line.
- **`hooks/sync.ts`:** strip the project in `packDays`.
- **README:** rewrite "What it shows" and "How the estimate works", and add "Projects" and "Other".

## Tests

- **Your Saturday (10 October):** 39% from noon to 11:00 gives the same projection all night (6% to spare). It moves only at 11:00 (9% to spare).
- **A heavy day:** 30% used on that Saturday turns it into "runs out Wed ~15:30" immediately. Use under the pace leaves it unchanged until the day ends.
- **A day across the reset:** the 7-day pace spans the reset; the first day of a window gets no `early` tag when 7 days are on record.
- **Weekday user, Monday reset, three weeks of record:** the weekday profile gives 25% to spare on Wednesday, and the 7-day pace alone gives 16%.
- **Fresh install:** 1.3's figure with `early`.
- **Self-check:** with a typical miss of 12, `±12` shows; with 4 it doesn't.
- **Active day:** ¼ of the median nonzero day; a day of a few prompts on Pro isn't active when the median day is 15%.
- **Daily budget and predicted use:** 13.5 ÷ 14.6 = 92.5%; the line is red over 100%.
- **Projects:**
  - the worktree and scratch-workspace mapping;
  - the rows plus Other plus Unused add up to 100%;
  - `packDays` never contains a project name.
- **5-hour clock text:** cut-off, lasting to the reset, and a reset after midnight.
- **Render:**
  - the line above the prompt, full and narrow, including `±` and `early`;
  - the terminal shows the same figures as text.

## Rollout

1.4.0. Settings and data are backward compatible, and sync is unchanged on the wire. Release notes should say the weekly figure now uses your last 7 whole days and holds still when you're idle.

## Backlog, not in 1.4

- **Pooled model costs** across sync users (opt-in, totals only).
- **Encrypted project names in sync,** with a device-pairing secret.
- **Plan fit:** what was left at each weekly reset, and how often the 5-hour wall was hit.
- **Learning model costs across breaks** when sync shows no other device was in use.
- **A quiet mode:** the line above the prompt only when a limit is at risk.
- **Model cost per hour of your usual work** on the models card.

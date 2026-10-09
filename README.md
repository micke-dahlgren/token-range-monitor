# Token Range Monitor

A Claude Code mod that tells you, like an electric car's range display, whether your current pace will carry you to the next limit reset.

It watches the weekly and 5-hour usage limits of your Claude Pro or Max subscription. It projects what will be left of each one when it resets, if you keep using Claude at the rate you have been.

<!-- Screenshot: add docs/pane.png and uncomment
![The Token Range Monitor pane](docs/pane.png)
-->

## Install

In a terminal, start `claude` and run:

```
/plugin install token-range-monitor --marketplace micke-dahlgren/token-range-monitor
```

Answer `y` to add the marketplace, then choose the **user** scope so it runs in every session. It also runs in sessions in the Claude desktop app's Code tab. The install line itself only works in a terminal.

To update later:

```bash
claude plugin update token-range-monitor
```

## What it shows

**Above the prompt**, one line:

> Left at week reset **−25%** · Resets in 3.7 days · Left at 5h reset **+12%** · Resets in 2.4 hours · Details

- **Left at reset** is what's projected to remain of the limit when it resets, at your current rate. A positive value (green) means you'll make it with that much to spare. A negative value (red) means you'd need that much more than you have.
- Click **Resets in…** to switch between days and hours (or hours and minutes for the 5-hour window). Under an hour, the 5-hour countdown is in minutes.
- **Details** opens the pane.

**The pane** has one card per limit, showing:

- **Left at reset**, **Average** (your usage rate) and **Limit** (the highest rate you can keep up until the reset without running out). When you're over, it also says when you'd run out.
- A chart of your usage over the averaging window, ending at *Now*. The dotted line is your average and the solid line is the limit. If the dotted line is above the solid one, you'll run out before the reset.
- Bars are usage seen as it happened. Stretches the plugin didn't see (before it was installed, or while no session here was getting responses) show as one low block labelled with what's known, like "12% used while away, 9h".
- For the weekly limit, a choice of what the average covers:
  - **Since reset** (the default): your usage since the weekly reset, from Anthropic's own figure. It needs no recorded history, so it works right after you install.
  - **Custom:** the last 1–24 hours or 1–7 days.

Open the pane with `/token-range`. You can also set the window from the prompt: `/token-range 2d`, `/token-range 12h` or `/token-range reset`.

## How the estimate works

Each limit's percentage and reset time arrive with Claude's responses. The mod records them and works out your usage rate over the chosen window:

- **Projected left at reset** = 100% − (used now + rate × time until reset)
- **Limit** = what's left ÷ time until reset

The mod shows **No data** rather than a misleading number when there isn't enough behind the average:

- **A custom window needs that much recorded history.** A 2-day average needs 2 days of readings.
- **Weekly estimates need at least 6 hours of data.** The weekly percentage moves in steps of about a point, so over a short stretch a single step reads as a huge rate.
- **Since reset waits 6 hours after each weekly reset.**
- **The 5-hour estimate averages since the window opened,** from Anthropic's own figure, and its chart shows the whole window. It starts 15 minutes after the window opens.

### Recent pace

The weekly card also answers "if I keep going like the last hour, when do I run out?"

The weekly percentage moves in whole points, too coarse to read one hour from. The 5-hour percentage moves several times faster, so the pace is read from it:

1. From your recorded history, the mod learns how many 5-hour points go with one weekly point on your account. It waits for 3 weekly points before trusting that.
2. Your last hour of 5-hour usage, divided by that ratio, is your weekly pace.

**How is this worked out?** under the line shows the numbers for your account. It's an estimate, and it settles as more usage is recorded.

### Model costs

Every response, subagents' included, reports its model, effort and tokens. Between two readings of the weekly limit that this computer watched throughout, the mod knows how far the limit rose and which models did the work. Over the last 14 days it solves for each model's weight. Within a model, output, input and cache tokens are combined at that model's published price ratios, so only the weight across models is learned.

Each model is judged on its own. Its cost shows once the 90% range of its weight is within ±20%. Until then its row shows **Learning** with a meter, and its points this week wait under **Not split yet**. A model you rarely use, like Haiku in subagents, can take days.

## Good to know

- **Pro and Max subscriptions only.** API-key usage has no subscription limits to show.
- **History starts when you install it.** Readings are recorded while a Claude Code session is open, and every session on this computer shares them. Usage on claude.ai or another device shows up as a jump at the next reading.
- **It keeps one history per account.** Limits belong to the signed-in account and organization, so signing in to another account switches to that account's own history.
- **Your data stays on your computer,** in the mod's own storage in your Claude Code configuration folder. Nothing is sent anywhere.
- **Built on Claude Code's early-access mod API.** A Claude Code update may change that API and break the mod before it's updated.

## Development

Run it from this folder without installing:

```bash
claude --plugin-dir .
```

Check and test it:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## License

MIT

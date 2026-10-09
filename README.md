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

> Left at week reset **−25%** · Resets in 3.7 days · Left at 5h reset **+12%** · Details

- **Left at reset** is what's projected to remain of the limit when it resets, at your current rate. A positive value (green) means you'll make it with that much to spare. A negative value (red) means you'd need that much more than you have.
- Click **Resets in…** to switch between days and hours (or hours and minutes for the 5-hour window).
- **Details** opens the pane.

**The pane** has one card per limit, showing:

- **Left at reset**, **Average** (your usage rate) and **Limit** (the highest rate you can keep up until the reset without running out). When you're over, it also says when you'd run out.
- A chart of your usage over the averaging window, ending at *Now*. The dotted line is your average and the cyan line is the limit. If the dotted line is above the cyan one, you'll run out before the reset.
- For the weekly limit, a choice of what the average covers:
  - **Since reset:** your usage since the weekly reset, from Anthropic's own figure.
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
- **The 5-hour estimate averages the last 30 minutes.**

## Good to know

- **Pro and Max subscriptions only.** API-key usage has no subscription limits to show.
- **History starts when you install it.** Readings are recorded while a Claude Code session is open. Usage on claude.ai or another device shows up as a jump at the next reading.
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

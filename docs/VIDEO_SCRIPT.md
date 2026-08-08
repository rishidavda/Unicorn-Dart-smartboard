# Staff training video — script & storyboard

Companion to [STAFF_MANUAL.md](STAFF_MANUAL.md). The generated video (`dartboard-staff-guide.mp4`,
1080p, ~4 min) uses these 18 slides with a synthesized voiceover; this script is the source if you
want to re-record the narration with a human voice, or re-shoot it as real footage at the venue.

Format: **On screen** (what the slide shows) / **Voiceover** (what is said — also shown as
subtitles, so the video works muted).

| # | On screen | Voiceover |
|---|-----------|-----------|
| 1 | **The Dartboard System** — the quick staff guide | Welcome. This is the quick guide to the automatic darts scoreboard. How it works, and how to fix it when it sulks. |
| 2 | Architecture diagram: Board → Pi → screens | The dartboard senses every dart and sends it over Bluetooth to the Raspberry Pi, the small box that runs everything. The TV and the iPad are just web browsers, showing what the Pi knows. |
| 3 | **Which side of the Pi is broken?** — board side = Bluetooth & batteries · screen side = Wi-Fi & browsers · everything = the Pi | When something breaks, ask: which side of the Pi is the problem? Missed darts and searching messages are board side — Bluetooth or batteries. Frozen screens are Wi-Fi or browser trouble. And everything dead at once means the Pi itself. |
| 4 | **Only ONE device can talk to the board** | Only one device can talk to the board at a time. Someone's phone running a darts app will silently block the whole system. |
| 5 | **Always select the venue** (New Match form) | Starting a match: open kcapp on the iPad, create the match, and always select the venue. Miss it, and the board will never connect, with no error to tell you why. |
| 6 | **"Searching…" then "Connected"** | Watch the screen. "Searching for smartboard", then "Connected to smartboard". From there, darts score themselves. |
| 7 | **Button first, then pull darts** | The button on the board's rim means end of turn. Press it before pulling the darts out. Pull too early, and the board can score darts nobody threw. |
| 8 | **Winning needs a human** (Confirm Checkout) | When someone wins, the game waits for a human. Tap one, two, or three in the Confirm Checkout box on the iPad. Until you do, the match looks stuck. That's deliberate. |
| 9 | **When scoring breaks…** climb the ladder | When scoring breaks, climb the fix ladder. Easiest step first. |
| 10 | **Step 1 — Tap "Reconnect Smartboard"** | Step one. Tap Reconnect Smartboard. It's in the player order box on the iPad's scoring page. |
| 11 | **Step 2 — Check the board** | Step two. Check the board. Wake it with a dart or a button press. If darts have been going missing, fresh batteries, always. And make sure nobody's phone is connected to the board. |
| 12 | **Step 3 — Refresh the screens** | Step three. Refresh the screens. Pull down on the iPad page, or force quit Safari and open it again. |
| 13 | **Steps 4–6 — Call the tech, or pull the plug** | Still broken? Steps four to six belong to the tech, restarting the bridge and Bluetooth. But the last one, anyone can do. Unplug the Pi, count to ten, plug it back in. Two minutes later it's all back, and the scores are safe. |
| 14 | **Trap 1 — "Searching…" never times out** | Two traps to know. First: "Searching for smartboard" never times out. If it's been thirty seconds, it isn't going to find it. Start fixing. |
| 15 | **Trap 2 — "Already Connected" but no darts** | Second: if the screen says Already Connected, but darts don't count, the bridge has been fooled — usually by dead batteries. Only restarting the bridge fixes it. The Reconnect button won't. |
| 16 | **Scores shifted, bull is right?** (ring rotated) | Scores wrong, but consistently wrong, and the bullseye fine? The number ring has rotated. Turn it back, so the configured number sits next to the button. |
| 17 | **Can't fix it? Say what you saw** | If you can't fix it, message the tech. The exact words on screen, what you tried, and photos of the TV and the board's light. Then keep the game going — score manually on the iPad. Darts never stop for a software problem. |
| 18 | **The manual has the rest** | That's the quick version. The full staff manual has every symptom and every fix. Keep it bookmarked, and keep spare batteries behind the bar. |

## Re-shooting with real footage

If you film it for real, the shots that add the most over slides are:

1. The actual **Reconnect Smartboard button** on your iPad (slide 10).
2. Changing the **batteries** on your board — where the compartment is (slide 11).
3. The **Pi's location and its power plug** for the unplug-count-to-ten reboot (slide 13).
4. The **Confirm Checkout** box appearing after a real checkout (slide 8).

Keep each clip under 15 seconds and read the same voiceover lines — the script above is timed to
roughly 4 minutes at a relaxed reading pace.

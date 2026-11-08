# Lost Cities Pinball

A portrait-first pinball game inspired by *Keeper of the Lost Cities*. Plain HTML, CSS and JavaScript. No build step, no dependencies. All art and sound are generated in code.

## Run it

Open `index.html` directly in a browser, or serve the folder statically:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`. On a phone, open the same URL over your local network (or host the folder on any static host) and add it to the home screen for a full-screen feel.

Add `?debug` to the URL to expose a `window.LCP` object in the console (game state, the config, and helpers to trigger modes) for testing.

## Controls

| Input | Action |
|---|---|
| Touch and hold the **left half** of the screen | Left paddle |
| Touch and hold the **right half** of the screen | Right paddle |
| Both thumbs | Both paddles (multi-touch) |
| `←` / `Z` and `→` / `M` | Paddles on desktop |
| `Space` | Start / play again / resume |
| `Esc` or `P` | Pause |

The ball launches by itself at the start of every ball, and again if it ever settles in the launch lane.

## Files

```
index.html   page structure, HUD, title / how-to / pause / game-over screens
style.css    layout, palette variables, collage-grid menu styling
game.js      config, physics, table, rules, audio, rendering, input
assets/      optional artwork (see below)
```

## Tuning

Every tuning value is in the `CONFIG` object at the top of `game.js`:

- `physics.gravity`, `physics.wallBounce`, `physics.maxSpeed`, `physics.airDrag`: ball weight and bounce.
- `flipper.swingUp`, `flipper.swingDown`, `flipper.bounce`, `flipper.length`: flipper strength and size. The ball leaves a flipper at roughly the flipper's surface speed (`length x swingUp` at the tip).
- `launch.speed`, `launch.delay`, `ballSave`: auto-launch power, delay, and the ball-save window.
- `bumper.kick`, `bumper.minOut`, `sling.kick`: how hard bumpers and the lower guides kick.
- `scores`: every score value.
- `modes`: bumper hits that summon the Neverseen, hurry-up time and shots needed, Alicorn and wizard durations, locks needed for multiball.
- `fx`: global multipliers for screen shake, flashes and particle count.

Colours come from `CONFIG.palette` (in JS) and the matching CSS variables at the top of `style.css`.

The physics runs at a fixed 240 Hz step (`physics.step`), so four sub-steps per 60 fps frame. At the speed cap (1500 px/s) the ball moves about 6 px per step, less than its 8 px radius, so it cannot tunnel through walls or flippers.

## Your own artwork

Drop files into `assets/` and they are picked up automatically if present (missing files are simply ignored):

| File | Used for |
|---|---|
| `assets/backdrop.png` or `.jpg` | Table backdrop (drawn at 40% opacity behind the playfield) |
| `assets/ball.png` | Ball face (square image, drawn as a circle) |
| `assets/title.png` | Cover image on the title screen's hero tile |

Use only artwork you have the rights to.

## Modes

- **Light Leap**: light all five crystals. Beam, flash, bonus and a multiplier step (up to x5). Ramps light crystals too.
- **Abilities**: hit all four ability orbs for a multiplier step.
- **Foxfire tower**: lock three balls for multiball (jackpot ramps).
- **Black Swan**: hidden scoop on the left with a random clue or award.
- **Neverseen**: lights go violet; hit three flashing shots before the countdown ends. Triggered by bumper hits or the swan.
- **Alicorn wing**: spin the spinner about 20 times for a timed double-score bonus.
- **Keeper of the Lost Cities** (wizard): complete all five modes above. Every crystal blazes and every shot scores.

Best score and the mute and reduced-motion settings are saved in `localStorage`.

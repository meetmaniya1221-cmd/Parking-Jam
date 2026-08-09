# Gridlock City

> Untangle impossibly packed parking lots one perfect slide at a time, and watch a gridlocked city come back to life — district by district, horn by horn.

A playable implementation of the *Gridlock City* design document: a traffic-unblock puzzle with a City Rebuild meta, built as a portrait-first web game in TypeScript with no runtime dependencies.

```
npm install
npm run dev        # play it at http://127.0.0.1:5173
npm run verify     # typecheck + unit tests + production build
npm run smoke      # drive the real game in Chromium and screenshot it
npm run gallery    # screenshot a spread of lots, modifiers and a11y modes
npm run progression # watch the lot grow, level 1 to 24, on three screen sizes
npm run layout     # assert the HUD fits, in six a11y modes on three viewports
```

## The game in one paragraph

Every lot is an integer grid. Every vehicle is an axis-aligned segment with a facing, and it moves only along that facing — forward or back. Reach a curb cut and it commits and drives off. Blocked, it honks, wobbles, and flashes the car that said no — and you have three of those before the jam resets. The puzzle is never *can I move this car*, it is *can I read the order*. Clear the lot and the district earns a little more of itself back.

## How it is put together

Three layers, strictly separated — the same split the design document specifies, and the reason the whole thing is testable.

| Layer | Path | What it owns |
|---|---|---|
| Deterministic sim | `src/core` | The lot as integers. No DOM, no clock, no randomness that is not seeded. |
| Presentation | `src/view`, `src/audio`, `src/game` | Canvas rendering, input, animation, procedural sound. All of it skippable. |
| Meta & services | `src/meta`, `src/ui` | Economy, save, districts, garage, screens. |

The sim is the interesting constraint: because `sim.ts` is a pure function of `(state, request)`, the identical code runs in the client, in the solver, in the level generator, and in the tests. Validation is free.

### `src/core` — the sim, the solver, the forge

**`sim.ts`** resolves every move. A drag becomes a `Move` or a bump; oil slicks carry a car past where it was aimed; one-way arrows refuse travel against them; the Velvet Rope holds ordinary cars while a VIP is still on the lot; a roundabout plate lets a nosed car pivot ninety degrees.

**`solver.ts`** answers "can this still be cleared" two ways:

1. **Exit closure.** A car only ever leaves along its own facing, so removing one can never block another: "who can leave right now" only ever grows as the lot empties. Exit-only play is therefore *confluent* — drive off whoever can go, repeatedly, and you reach the same terminal lot whatever order you pick. That makes both success and failure linear-time, and it is the single observation that makes forty-car lots tractable at all. When it clears the lot the answer is provably optimal: clearing *n* cars needs at least *n* slides, and this clears them in exactly *n*.
2. **Reposition search** for lots that genuinely need a car pulled temporarily aside. Because exits are never harmful, taking every available exit before considering a slide loses no solutions, so the search only branches on slides from an already-stuck lot — and iterative deepening on the number of repositions returns a line with the fewest the lot can be beaten with.

It also measures difficulty, and not only as depth. Knot depth is the longest chain in the *precedence DAG*: a car only leaves along its facing, so every car standing on that ray must go first — an absolute ordering, independent of which valid solution the player picks. Alongside it: **bottlenecks** (cars that three or more others transitively wait on), **independent ratio** (cars that neither block nor are blocked — free parking), **density**, and **repositions**.

**`generator.ts` (JamForge)** builds lots **backwards**. Vehicles are inserted one at a time, and an insertion is only accepted if that car could drive straight off the lot given everything already placed. Replaying the insertions in reverse is therefore always a valid solution, which makes every generated jam solvable by construction — the promise the design document makes to the player, kept structurally rather than by testing after the fact.

Nothing about the lot is hoped for. Every insertion carries an explicit *intent*, chosen from where the partial lot currently stands against its contract: anchor the knot, deepen it, cork a lane that is standing open, leave a car free to move, or park a red herring. Knot depth in particular is scored by the chain each placement would actually create, computed from a per-car "how deep is the knot above this car" pass — chasing a single chain tail stalls at three or four links, because each link starts closer to the street than the one it blocks.

**`difficulty.ts`** is the curve, in one table. A level index and band become a `DifficultyConfig`: board width and height, car target and floor, minimum dependency depth, minimum solution moves, how many cars may drive off on turn one, how many bottlenecks it must have, how much free parking it may contain, how dense it must be, and whether it must require a temporary reposition. It is a *contract* — the generator builds toward it and the solver grades the result against it — and every number in it is a tunable.

**`campaign.ts`** describes 320 launch jams rather than storing them. A global level index determines band, pattern, street frontage and modifier load, and pulls the rest from the curve; JamForge turns that into the same lot on every device, every time. The whole sequence costs zero bundle bytes.

### The curve: the lot itself grows

The board is not a constant. Difficulty on a fixed grid runs out of room — a dependency chain can only be as long as the lanes it runs down, and a bottleneck only reads as one when there is enough lot around it to be bottled — so the *parking structure* is what scales, and everything else scales with it.

| Level | Grid | Cells | Cars | Depth | Density | Cell on a phone |
|---|---|---|---|---|---|---|
| 1 | 6×8 | 48 | 5 | 3 | 0.21 | 63 px |
| 5 | 7×9 | 63 | 8 | 4 | 0.27 | 54 px |
| 10 | 9×11 | 99 | 17 | 10 | 0.36 | 42 px |
| 15 | 11×13 | 143 | 26 | 8 | 0.48 | 34 px |
| 20 | 13×16 | 208 | 32 | 11 | 0.53 | 29 px |
| 320 | 13×16 | 208 | 37 | 17 | 0.57 | 29 px |

The last column is the point of the whole exercise. The lot on screen stays roughly the same size — around 375 px on a 412 px phone — while the number of cells inside it triples, so a car takes up about a twentieth of the board at level one and under a hundredth by level twenty. The player is not looking at a bigger picture of the same puzzle; they are looking at a car park.

| | L1–9 | L10–20 | L21–40 | L41–80 | L81–160 | L161–320 |
|---|---|---|---|---|---|---|
| Cars | 8.7 | 24.1 | 31.5 | 31.6 | 31.5 | 31.6 |
| Knot depth | 4.9 | 10.2 | 13.0 | 13.1 | 12.5 | 13.4 |

Growth is front-loaded into the first twenty levels and then stops: past 12×15 a cell on a phone falls below what a thumb can reliably pick out of a packed lot, and difficulty bought by making the game harder to *see* is the one kind worth refusing. From there the curve carries on through depth, bottlenecks, vocabulary and the forced reposition, which have no such ceiling.

Every lever still has to move together. Knot depth past four links needs a chain that turns corners; a corner needs a crossing lane with its own curb cut; so the grid and the street frontage remain the *ceiling* on depth, not decoration alongside it. A pinched frontage gets its depth target scaled down to what its geometry can actually hold, rather than failing every candidate and silently shipping a near-miss.

Stretch is the default texture of a chapter at 53% rather than its peak at 20%, and breathers survive at 14%. They are rest, not easy: a level-21 breather carries thirty-two cars on a 12×15 lot — it just opens with fourteen of them free to move, where a stretch jam of the same size opens with two.

`npm run test` prints the delivered curve on every run (`tests/curve.report.test.ts`), including which parts of its contract each level missed. That readout is not decoration: difficulty here is *requested* by the config and *delivered* by the generator, and the two are not the same number.

### Solver validation: the curve has teeth

A generated lot is not shipped because it was generated. Every candidate is solved, measured and graded against its own `DifficultyConfig`; if it misses on cars, depth, solution length, opening moves, bottlenecks, free parking or density, it is thrown away and another is rolled. Only when no candidate in the budget clears the contract does the closest near-miss ship — because an unbuildable level is worse than a slightly easy one, and the readout says which levels those are.

That is what stops a level-fifteen lot from being a level-five lot on a big board. `tests/progression.test.ts` asserts the mechanism directly: grade a real level-five lot against level fifteen's contract and it must fail on cars, depth, moves *and* bottlenecks.

### The pinwheel: forcing a temporary move

Up to level thirteen every jam clears by driving cars off in the right order, so the read is "find the order". Past it, the harder bands demand a lot that cannot be solved that way — the player has to pull a car temporarily aside and put it back in play, which is a different kind of thinking.

In this movement model there is exactly one shape that forces it. Cars travel in straight lines along a fixed facing, so a knot with no *cycle* in it always unties by exits alone; the deadlock has to be a ring:

```
A A . .     A faces east into B
. . . B     B faces south into C
D . . B     C faces west into D
D . C C     D faces north into A
```

Nobody in the ring can leave and no exit will ever help. It is opened by reversing one car a full body length out of the lane it is standing across, after which the ring unwinds.

The ring is placed into the **empty** lot before anything else, which is what makes the escape provable rather than hoped for: JamForge builds backwards, so the four ring cars are the last things left on the lot, alone, with the reverse lane and all four exit lanes they were checked for still clear. Any of the four can be the car that backs out — the ring is symmetric under rotation — and the cells the escape depends on are reserved so no cone or oil slick can land in them. If no position in the lot satisfies all of that, the injection is simply skipped and the level ships without it.

### A finding worth writing down

The obvious lever for difficulty — narrowing the street frontage — turned out to do the opposite of what it looks like. A car only ever leaves straight along its facing, so a curb cut on a given lane is what makes that lane usable at all. Open one edge and every car must face the same way: the lot is a shallow queue that holds few cars and knots barely three deep. Open four and lanes cross, dependency chains can turn corners, and the same grid packs denser *and* knots deeper.

Measured across 120 generated lots on a 7×10 grid:

| Street sides × width | Median cars | Median knot depth | Max depth |
|---|---|---|---|
| 2 × 0.45 | 12 | 4 | 7 |
| 3 × 0.60 | 16 | 5 | 8 |
| 4 × 0.90 | 16 | 7 | 10 |

So difficulty lives in density, distractors and vocabulary. Frontage *width* became the band lever — every lot past the on-ramp fronts onto four streets, and how much of each edge is curb cut is what decides how many cars can drive off on turn one.

That finding also set a limit on the growth curve. The Plug and the Two-Door are frontage reads — one lane out, or two flows competing for it — and on a small lot that is the whole puzzle. On a 12×15 one it stops being a read and becomes an amputation: two facings unusable, half the lot wasted, and a knot that cannot chain past its longest queue. Past the on-ramp they keep their pinch but not their blindfold.

The related trap: how open a lot feels on move one has to be scored as a *share* of the cars, not a count. Four free cars out of eight and four out of thirty-two are nothing alike, and an absolute threshold quietly mis-graded every large lot. Measured as a share, the bands come out clean:

| Band | Median bump likelihood |
|---|---|
| Breather | 0.57 |
| Standard | 0.90 |
| Stretch | 0.93 |
| Showcase | 0.95 |

The same trap bit the Velvet Rope. While a VIP is on the lot nobody else may leave, so the number of VIPs *is* the number of legal opening moves — one VIP on a thirty-car lot is not a read, it is hunting a single legal move among thirty. VIP count now scales with the lot, tightens on the stretch bands, and never appears on a breather at all.

### `src/view` — the lot you can touch

A 2D toy diorama, lit by one warm key from the upper left. Every solid thing is built the same way — a base footprint, a lifted top face, and the side faces between them.

A vehicle is not one brick but a **stack of volumes**: a lower body, and then a greenhouse, a cargo box or a roof sign standing on top of it. That stack is what gives each class a silhouette you can name before you read its colour — a cab-and-box truck, a nearly-full-length coach canopy, a flatbed with the cab at the nose, a stubby coupe cabin. On top of the body sit headlamps, tail lights and a grille shadow, so which way a car faces reads from its own shape rather than from a marker laid over it.

Extrusion height is deliberately low, and the stack shares one budget with the body rather than adding to it. A lifted top face is drawn *above* its own cells, so a tall car covers the one parked behind it — enough height to read as a solid object, not so much that it hides a neighbour and breaks the count.

The asphalt is not a flat fill: aggregate grain, old spills and tyre scuff are generated once into a repeating tile, and the slab carries bay paint, an occlusion ring at the kerb line and a vignette that lands the eye centre-lot. The lot sits inside a raised concrete lip, which is what seats it in the street instead of floating on it.

Two caches keep that affordable. The ground is baked to an offscreen canvas and blitted — at *board* extent rather than viewport extent, so a panning camera is a blit at a different offset rather than a rebake, and the bake only repeats when the cell size or the palette changes. And a vehicle that is not mid-bump draws the identical picture every frame, so it is rendered once into its own small canvas and blitted thereafter — a still frame costs one ground image plus one image per car. Anything mid-bump falls back to painting live, which is at most a car or two at a time; both paths call the same paint function, so there is exactly one description of what a car looks like. Nothing uses `shadowBlur` — every soft edge here is cheaper as a stack of shapes.

Slides use an anticipation ease: a short pull-back, an eased run, a two-bounce suspension settle, and a body that leans against its own acceleration. Exits accelerate away. The last car gets four tenths of a second of slow motion and a camera pull-back.

#### Fitting a growing lot on a fixed screen

Cells are sized to fit the play area — the region between the HUD and the boosters, which the grid layout guarantees the board can never escape. As the grid grows the cells shrink, which is the whole point: same screen, more car park.

They stop shrinking at 30 CSS pixels. A car is two cells long, so its *short* axis is one cell, and that is what a thumb has to land on in a packed lot; below thirty, picking the right car stops being a puzzle and starts being a dexterity test. Past that floor the lot **pans** instead — drag the asphalt to look around, double-tap it to flip between "whole jam visible" and "cells you can play". Dragging a car near the edge brings the view with it, so a gesture never walks its own car off screen, and keyboard selection follows the cursor for the same reason.

The floor yields up to 8% before panning engages, so a lot that *nearly* fits is shown whole at slightly tighter cells rather than with one column hanging off the edge. In practice that means a 412 px phone plays the entire campaign without panning, a 360 px one pans from about level fifteen, and the on-ramp never pans anywhere — early levels should not have to teach a camera control as well as the game.

`npm run progression` screenshots the milestone jams at three screen sizes and asserts each one sits between the HUD and the boosters at a touchable size.

### `src/ui` — one design system

Everything on screen is built from one idea: **a night parking structure under sodium light**. A near-black blue ground, panels lifted off it by a 1px catch-light and a shadow rather than by an outline, and exactly one warm accent — amber — for everything the player owns or is being offered. Cold colours are information (time, progress, distance) and red only ever means danger.

Three rules keep it from drifting:

1. **One accent.** Amber marks the actionable and the earned. A second accent competing for attention is how a HUD stops being readable.
2. **Depth by light, not by outline.** Every raised surface is a fill, a 1px top highlight and a shadow — the same recipe at three scales: chip, card, modal. Buttons carry a solid darker lip under the bottom edge and press *into* it, which is a state rather than an animation, so it survives reduced-motion intact.
3. **Semantic colour is never decorative.** A colour used for mood makes the same colour used for meaning unreadable.

The HUD is two rows, and the split is the point. The top row is *identity* — where am I, how do I leave — and the second is *state*: cars left, bumps, the rescue window, the slide meter. Mixing them put the level name next to a ticking clock and the eye could find neither. The meters row wraps rather than overflows, because four chips at 130% text scale on a 320 px phone do not fit one line and `.app` hides overflow — a clipped bump counter is worse than a second row.

Icons are the one thing here that is a baked asset rather than procedural. Everything else has to scale from a 63 px cell to a 29 px one and remap for three kinds of colour blindness; chrome icons render at one small size, never remap, and a glyph with real material on it — a gold tow hook, a red shield — communicates faster than a flat pictogram. They replaced a row of emoji, which is the single loudest way a game says "prototype": emoji render differently on every platform, carry someone else's art direction, and cannot be lit to match anything around them. The chip *behind* each icon is still CSS, which is where theming has to happen.

### `src/audio` — no sample bytes

Everything is synthesised at runtime. Three buses with independent toggles, per-class horn voices, tyre roll whose pitch and grain follow drag velocity, and an exit melody keyed to the district — a chained solve literally performs the tune, and the last car resolves it. Every piece of gameplay information lives on the SFX bus, so a music-off player loses nothing.

### `src/meta` — the city

Districts, seven projects each with costs that escalate by district index, City Income capped at four hours, Mystery Trunks with published odds, streaks that pause rather than reset, the Garage, the Dispatch Board, the City Pass, Service Medals as the slow always-advancing meter behind the daily loop, and Beautification as the endless cosmetic sink a late-game surplus needs — without it every later reward starts to feel like lint. Saves are versioned and defensively migrated: an older save is folded onto a fresh one so nothing is ever missing, and a hand-edited one is repaired without taking value away.

### Modes

The campaign is the game; the rest are appointments.

| Mode | Where | What it is |
|---|---|---|
| Campaign | 320 jams, twelve districts | Unlimited slides. Three bumps ends the attempt. |
| Metered Lot | Sprinkled from L45 | The only fail state, and the only save-me. Capped slides, always with slack above par, never on a mechanic's first five outings and never on a skill-check. Held at L45 deliberately while the puzzle vocabulary moved earlier — difficulty was worth front-loading, a fail state was not. |
| Rush Hour | Daily | One authored hard jam, one attempt, the same for everyone. |
| Cold Cases | From L70 | Every retired daily, replayable and untimed. |
| Night Shift | Tuesdays | The same reads by headlight only. 1.5× Miles. |
| Overtime Shifts | From L80 | A rotating set of ten rated jams a day, endlessly. |
| Gridlock Gauntlet | Monthly | Twelve escalating rungs on one continuous path, with three checkpoint chests. A checkpoint is a place to stop, not only to carry on. |

## Design commitments that are enforced in code, not just intended

- **Every jam is solvable unaided.** Guaranteed by construction in the generator, and re-verified for all 320 levels on every test run.
- **Three bumps ends the jam — and that is the only thing it costs.** A blocked car honks, wobbles and flashes the car that refused it, and the gauge steps neutral → amber → red *before* the consequence lands. The third one freezes the lot and offers Retry: no ad, no life, no currency, no confirmation between the tap and a fresh lot. The tutorial is exempt, because the three levels that teach "a blocked car just honks" must not also be the levels that punish you for finding out. One-way arrows and oil slicks make some slides irreversible, so there is an unlimited **Undo**, and when a lot really has been knotted for good the game notices and says so rather than letting the player grind at it.

  This replaced a free-bump rule, and the trade is worth naming: free bumps invite you to *probe* the lot, a bump limit makes you *read* it first. The second is tenser and asks more; it is one constant (`BUMP_LIMIT`) if it ever wants to move back.
- **A session never ends on a failure.** Running a Metered Lot dry offers the save-me; declining it hands the player a guaranteed-solvable breather, not a loss screen. The bump-out screen names the cause in the largest type on it, shows how much of the lot was cleared before it ended, and makes Retry the biggest warmest thing on the screen — a player who cannot name why they lost cannot play better, and one who cannot see their progress has no reason to go again.
- **Never more than one modal deep.** The win screen does not stack an offer on top of itself; the pinch offer and the interstitial are mutually exclusive, and the smoke test fails the build if two overlays are ever open at once.
- **Interstitials, exactly as specified.** Never before level 12, only on the way out of a win screen, ninety-second cooldown that lengthens after the sixth impression of a session, hard cap of twelve, and any purchase buys a twenty-four-hour holiday. There is no ad network here — the placements are honest simulations, so the guardrails around them are real and testable.
- **Nothing owned is ever removed.** Keys and tickets above their cap convert to Coins instead of evaporating. A broken streak pauses at its last milestone.
- **Odds are published in-game**, in the settings sheet, because they should be.

## Accessibility

Vehicle identity is never colour-only: class silhouettes differ, facing reads from the windscreen and light strip, one-way arrows are shape-coded, slicks carry a texture, and ambulances keep a cream body and a red cross whatever livery is equipped. On top of that sit three colourblind palette remaps, a high-contrast mode, reduced motion, three haptic levels, a left-handed layout, calm honks, and text scaling to 130% without layout breaks.

The VIP is the case that made the rule pay. It has to be findable in under two seconds among thirty-two cars, *and* stay findable when it is simultaneously selected, hinted, and the car that just refused to move — so it does not compete for the selection ring. It takes the ground instead: a slow-breathing pool of warm light nothing else in the game produces, plus a crown floating over the roof. The glow says "special"; the crown says *which* special, and it survives a colourblind remap, a high-contrast palette and a black-and-white screenshot the way a colour alone does not. Both are clipped to the asphalt, and a VIP parked in the top row gets its crown on its roof rather than hovering off the board.

`npm run layout` is the regression net under all of it: three viewports × six accessibility modes, asserting that nothing overflows, that the lot never slides under the HUD or the boosters, and that it is never squeezed to nothing. On a short screen the chrome gives way in priority order — the rules strip first, then the booster labels, then the header's breathing room — and nothing interactive is ever removed.

## Testing

`npm test` runs 142 unit tests: sim geometry and every modifier, solver optimality and dead-end detection, the full 320-level campaign audited for validity, solvability, par, band mix, gate compliance and difficulty scaling, the progression contract, plus the economy, medals, Metered-Lot gating and save layers.

The solvability audit is the one that makes the difficulty curve safe to move. Every one of the 320 lots is re-verified on each run to be clearable *and* clearable in exactly one slide per car plus the repositions the lot was built to force — so packing them denser and knotting them deeper cannot quietly ship an unfair jam.

`tests/progression.test.ts` audits the curve as a curve rather than as 320 separate lots: that the grid grows and never shrinks, that levels 1, 5, 10, 15 and 20 hit their size, density, depth and solution-length marks, that free parking dries up and bottlenecks multiply between them, that the late game really does require a temporary reposition — and that every one of them fits five different screen sizes with cells a thumb can hit.

`npm run smoke` is the one that catches what unit tests cannot. It boots the real game in Chromium at phone resolution, clears levels by dispatching genuine pointer events, drags a blocked car to check it bumps rather than escapes, **bumps a jam out three times and then clicks Retry to prove the lot really comes back with the counter reset**, undoes a slide, opens a hint, plays a Night Shift lot, runs a Metered Lot dry to check the save-me appears and that declining lands on a breather, plays a level with the keyboard alone, walks every meta screen, and fails on any console error, page exception, failed request, stacked modal or empty screen.

`npm run layout` is the one that catches a HUD outgrowing its row. `.app` hides overflow, so a chip that no longer fits does not break visibly — it silently clips, and which side it clips from changes with the left-handed setting. So the check is assertive rather than visual: three viewports (320, 412, 1440) crossed with six modes (base, 130% text, high contrast, deuteranopia, left-handed, reduced motion), failing on any horizontal scroll, any element escaping the app frame, any overlap between the lot and the chrome above or below it, and any lot squeezed under 140 px.

`npm run firstrun` measures the opening: time from navigation to a touchable lot, and whether the guiding hand arrives after four seconds of hesitation and points at a car that can actually leave. On this machine it reports about 300 ms to touchable against the production build.

That figure is up from roughly 240 ms before the lot was textured, and the difference is real rather than noise — measured by rebuilding both versions and running the probe against each. It buys aggregate grain, weathering, the occlusion ring and the vignette, and it is paid once per lot rather than per frame. The two obvious wastes were removed once they were measured: the street apron no longer gets a grain pass it would only have overdrawn, and the grain is filled at CSS resolution and blitted up instead of being stamped per device pixel — nine times less fill at dpr 3, on noise that loses nothing to the upscale.

`npm run gallery` screenshots a spread of lots covering every vehicle class and modifier, plus the colourblind, high-contrast and Night Shift modes — the fastest way to see whether a rendering change reads at a glance.

`npm run journey` goes the long way round: it restores two districts through the UI, watches the timelapse, collects capped income, builds a landmark, buys and equips a livery, then screenshots every accessibility mode and three viewports down to 320px, failing on any sideways scroll. `npm run perf` reports frame times — 16.7 ms flat at thirty-two cars, on a 4 MB heap.

`npm run progression` is the one that watches the curve happen. It loads levels 1, 5, 10, 15, 20 and 24 on a small phone, a large phone and a tablet, prints the grid, car count, cell size and whether the lot needed to pan, screenshots each, and fails if any board overlaps the HUD or the boosters, spills outside a viewport it claims to fit, or drops below a touchable cell size.

All of them write screenshots to `/tmp/gridlock-shots` for eyeballing.

`window.__gridlock` exposes the live sim for those harnesses — which car can leave, where a cell lands on screen, a `playBestMove()` that can open a deadlock ring a tapping bot cannot, and a `jumpTo(level)` that goes through the app rather than racing the save file.

## What is not here

This is the game, not the service. There is no backend, so anything that needs one is either absent or honestly labelled: Rush Hour shows a clear-rate *estimated from the jam's own measured shape* rather than a fabricated community figure, and the ad placements are simulations. The LiveOps modes that are fundamentally social — Ambulance Run leagues, the Motorcade community meter, Depot Crews, ghost solves, friends' Rush Hour stamps — need a server to mean anything, so they are not stubbed in. Cloud save, remote config, attribution and the analytics pipeline are the same story: covered by the design document, out of scope for a client.

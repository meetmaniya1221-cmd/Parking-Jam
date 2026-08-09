# Gridlock City

> Untangle impossibly packed parking lots one perfect slide at a time, and watch a gridlocked city come back to life — district by district, horn by horn.

A playable implementation of the *Gridlock City* design document: a traffic-unblock puzzle with a City Rebuild meta, built as a portrait-first web game in TypeScript with no runtime dependencies.

```
npm install
npm run dev        # play it at http://127.0.0.1:5173
npm run verify     # typecheck + unit tests + production build
npm run smoke      # drive the real game in Chromium and screenshot it
npm run gallery    # screenshot a spread of lots, modifiers and a11y modes
```

## The game in one paragraph

Every lot is an integer grid. Every vehicle is an axis-aligned segment with a facing, and it moves only along that facing — forward or back. Reach a curb cut and it commits and drives off. Blocked, it honks, wobbles, and flashes the car that said no — and you get three of those before the jam is lost. The puzzle is never *can I move this car*, it is *can I read the order*. Clear the lot and the district earns a little more of itself back.

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

1. **Exit-only search.** If no car ever needs repositioning, occupancy is a pure function of *who is left*, so the search memoises on a bitmask and finishes in microseconds. When it succeeds the answer is provably optimal — clearing *n* cars needs at least *n* slides, and this clears them in exactly *n*.
2. **Bounded best-first search** over full slide and pivot moves, for the lots that genuinely need a car pulled out of the way.

It also measures difficulty. Knot depth is the longest chain in the *precedence DAG*: a car only leaves along its facing, so every car standing on that ray must go first — an absolute ordering, independent of which valid solution the player picks.

**`forge.ts` (JamForge)** builds lots **backwards** from the empty lot, which is what makes solvability structural rather than hoped-for. Two kinds of backward step, interleaved: *un-exit* introduces a car at a spot it could drive straight off from, and *un-slide* shifts a placed car along its axis. Reversed, an un-slide is a **repositioning move** — one that clears nobody and exists only to make room. Every step is validated against the real sim as it is taken, and the finished trace is replayed end to end before the level ships.

**`analysis.ts`** measures what a lot will actually play like, and the generator rejects candidates against it. The sharpest measure is *greedy resistance*, and it rests on a small theorem: driving a car off only ever frees cells, so it can never cost another car its route — which means if a lot can be cleared by tapping at all, it can be cleared by tapping **in any order**. One greedy run therefore decides it, and a lot that stalls greedy is one where the player is *forced* to reposition something.

**`campaign.ts`** describes 320 launch jams rather than storing them. A global level index determines band, pattern, grid size, car count, knot depth, distractor ratio, street frontage and modifier load; JamForge turns that into the same lot on every device, every time. The whole sequence costs zero bundle bytes and every number in it is a tunable.

### The curve: a ten-level on-ramp, then it bites

Levels 1–3 teach the verb, 4–9 add vocabulary at a standard difficulty, and **level 10 is where the game stops being gentle** — a stretch jam on a 7×9 lot, fourteen cars, a knot nine deep. It is a step rather than a slope, and it is meant to be felt.

| | L1–9 | L10–20 | L21–40 | L41–80 | L81–160 | L161–320 |
|---|---|---|---|---|---|---|
| Cars | 6.0 | 12.0 | 13.5 | 13.7 | 14.1 | 14.3 |
| Solution moves | 10.9 | 22.7 | 22.9 | 23.7 | 25.6 | 25.7 |
| …of which reposition | 4.9 | 10.7 | 9.4 | 10.0 | 11.4 | 11.4 |
| Knot depth | 3.2 | 5.5 | 5.2 | 5.6 | 4.9 | 4.9 |

Every lever has to move together, and that is the part worth writing down. Knot depth past four links needs a chain that turns corners; a corner needs a crossing lane with its own curb cut; so the grid and the street frontage are the *ceiling* on depth, not decoration alongside it. Asking a 5×6 lot with two open edges for a knot of nine produces a lot of six, silently. The grid therefore jumps to 7×9 at level 10, standard jams front onto four streets rather than three, and the full puzzle vocabulary — blockers, one-ways, oil, VIPs, ambulances, roundabouts, gates — is open by level 18 instead of level 60. A lot with nothing in it but cars can only be made harder by adding more cars, and that is tedium rather than difficulty.

Stretch is now the default texture of a chapter at 53% rather than its peak at 20%, but breathers survive at 18%. They are rest, not easy: a level-21 breather carries sixteen cars, more than any lot in the old game before level 100. A curve with no let-up in it reads as a wall.

Neither depth nor car count climbs into the late game, and both are deliberate. Depth counts how many cars are stacked in one lane, and stacking lanes is what stopped the puzzle working; density is capped for the same reason. What grows is the amount of untangling — the repositioning row above.

`npm run test` prints the delivered curve on every run (`tests/curve.report.test.ts`). That readout is not decoration: difficulty here is *requested* by the spec and *delivered* by the generator, and the two are not the same number.

### The finding that reversed the whole design

Difficulty does **not** live in density. It is destroyed by it.

The previous generator inserted every car where it could drive straight off, then rejected anything without a pure exit-only solution — which guaranteed, by construction, that no car ever needed repositioning. Measured over the shipped campaign: greedy tapping cleared **320 of 320 levels** across 8,320 runs, with a median 47% of cars able to leave on move one. The knot depth those lots reported was real; nothing ever asked the player to use it.

What defeats tapping is a **ring**: A parked across B's lane while B is parked across A's. A car's route to the curb is fixed geometry, so exit-only clearing is possible exactly when "X is in Y's way" is acyclic — and a ring is a proof that some car must be shifted aside first. Rings have to be *built*, and building one needs cars that can still slide:

| Cars on a 7×10 lot | Levels that resist tapping |
|---|---|
| 12–18 | 75–100% |
| 20–21 | ~12% |

Past roughly eighteen cars nothing can move, no ring can be built, and the generator ends up shipping whatever near-miss it managed. So car counts are capped well below what the lot could hold. **Room to manoeuvre is a resource the puzzle spends**, and a fuller board is an easier one.

Where it lands: 207 of 320 levels can no longer be finished by tapping, against 0 before. Solutions average 26 moves of which 11 clear nobody, against exactly one move per car and no repositioning at all. About a third still fall to greedy — the forge could not find a ring on that board — and generation now costs 200–500 ms a level against a few tens of ms, which wants baking at build time rather than running on device.

### An earlier finding, still true

The obvious lever for difficulty — narrowing the street frontage — turned out to do the opposite of what it looks like. A car only ever leaves straight along its facing, so a curb cut on a given lane is what makes that lane usable at all. Open one edge and every car must face the same way: the lot is a shallow queue that holds few cars and knots barely three deep. Open four and lanes cross, dependency chains can turn corners, and the same grid packs denser *and* knots deeper.

Measured across 120 generated lots on a 7×10 grid:

| Street sides × width | Median cars | Median knot depth | Max depth |
|---|---|---|---|
| 2 × 0.45 | 12 | 4 | 7 |
| 3 × 0.60 | 16 | 5 | 8 |
| 4 × 0.90 | 16 | 7 | 10 |

So frontage width became a *simplicity* lever — reserved for the opening levels and for the deliberately constrained Plug pattern. (The conclusion drawn at the time, that difficulty lives in density, is the one the section above overturns.)

The related trap: how open a lot feels on move one has to be scored as a *share* of the cars, not a count. Four free cars out of eight and four out of twenty are nothing alike, and an absolute threshold quietly mis-graded every large lot — including the daily Rush Hour, which was generating at knot depth 3 while advertising itself as the hardest jam of the day. Measured as a share, the bands come out clean:

| Band | Median bump likelihood |
|---|---|
| Breather | 0.33 |
| Standard | 0.50 |
| Stretch | 0.60 |
| Showcase | 0.57 |

### `src/view` — the lot you can touch

A 2D toy diorama, lit by one warm key from the upper left. Every solid thing is built the same way — a base footprint, a lifted top face, and the side faces between them.

A vehicle is not one brick but a **stack of volumes**: a lower body, and then a greenhouse, a cargo box or a roof sign standing on top of it. That stack is what gives each class a silhouette you can name before you read its colour — a cab-and-box truck, a nearly-full-length coach canopy, a flatbed with the cab at the nose, a stubby coupe cabin. On top of the body sit headlamps, tail lights and a grille shadow, so which way a car faces reads from its own shape rather than from a marker laid over it.

Extrusion height is deliberately low, and the stack shares one budget with the body rather than adding to it. A lifted top face is drawn *above* its own cells, so a tall car covers the one parked behind it — enough height to read as a solid object, not so much that it hides a neighbour and breaks the count.

The asphalt is not a flat fill: aggregate grain, old spills and tyre scuff are generated once into a repeating tile, and the slab carries bay paint, an occlusion ring at the kerb line and a vignette that lands the eye centre-lot. The lot sits inside a raised concrete lip, which is what seats it in the street instead of floating on it.

Two caches keep that affordable. The ground is baked to an offscreen canvas and blitted. And a vehicle that is not mid-bump draws the identical picture every frame, so it is rendered once into its own small canvas and blitted thereafter — a still frame costs one ground image plus one image per car. Anything mid-bump falls back to painting live, which is at most a car or two at a time; both paths call the same paint function, so there is exactly one description of what a car looks like. Nothing uses `shadowBlur` — every soft edge here is cheaper as a stack of shapes.

Slides use an anticipation ease: a short pull-back, an eased run, a two-bounce suspension settle, and a body that leans against its own acceleration. Exits accelerate away. The last car gets four tenths of a second of slow motion and a camera pull-back.

### `src/audio` — no sample bytes

Everything is synthesised at runtime. Three buses with independent toggles, per-class horn voices, tyre roll whose pitch and grain follow drag velocity, and an exit melody keyed to the district — a chained solve literally performs the tune, and the last car resolves it. Every piece of gameplay information lives on the SFX bus, so a music-off player loses nothing.

### `src/meta` — the city

Districts, seven projects each with costs that escalate by district index, City Income capped at four hours, Mystery Trunks with published odds, streaks that pause rather than reset, the Garage, the Dispatch Board, the City Pass, Service Medals as the slow always-advancing meter behind the daily loop, and Beautification as the endless cosmetic sink a late-game surplus needs — without it every later reward starts to feel like lint. Saves are versioned and defensively migrated: an older save is folded onto a fresh one so nothing is ever missing, and a hand-edited one is repaired without taking value away.

### Modes

The campaign is the game; the rest are appointments.

| Mode | Where | What it is |
|---|---|---|
| Campaign | 320 jams, twelve districts | Unlimited slides, no fail state. |
| Metered Lot | Sprinkled from L45 | A slide cap on top of the three-bump rule, and the only save-me. Capped slides, always with slack above par, never on a mechanic's first five outings and never on a skill-check. Held at L45 deliberately while the puzzle vocabulary moved earlier — difficulty was worth front-loading, a fail state was not. |
| Rush Hour | Daily | One authored hard jam, one attempt, the same for everyone. |
| Cold Cases | From L70 | Every retired daily, replayable and untimed. |
| Night Shift | Tuesdays | The same reads by headlight only. 1.5× Miles. |
| Overtime Shifts | From L80 | A rotating set of ten rated jams a day, endlessly. |
| Gridlock Gauntlet | Monthly | Twelve escalating rungs on one continuous path, with three checkpoint chests. A checkpoint is a place to stop, not only to carry on. |

## Design commitments that are enforced in code, not just intended

- **Every jam is solvable unaided.** Guaranteed by construction in the generator, and re-verified for all 320 levels on every test run.
- **Three bumps and the jam is lost.** A bump is still diagnostic — it honks, wobbles and flashes the car that refused — but it is no longer free: the third one ends the level immediately and offers a retry of the same lot. The counter warns at one and shouts at two, and the Dispatcher offers help at two rather than six, because the help has to arrive *before* the last strike rather than after it. Leaning on the same blocked car repeatedly is one collision, not three; the count only moves when something about the refusal changes.
- **Undo is still unlimited** within a jam, and one-way arrows and oil slicks make some slides irreversible, so it is needed. When a lot really has been knotted for good the game notices and says so rather than letting the player grind at it.
- **A failure always hands back the same lot, immediately.** Retry restores every car to its authored position and facing, zeroes the bump count, drops the undo history and clears the collision state — the level is rebuilt from its definition rather than patched back toward the start. Running a Metered Lot dry still offers the save-me, and declining it hands the player a guaranteed-solvable breather.
- **Never more than one modal deep.** The win screen does not stack an offer on top of itself; the pinch offer and the interstitial are mutually exclusive, and the smoke test fails the build if two overlays are ever open at once.
- **Interstitials, exactly as specified.** Never before level 12, only on the way out of a win screen, ninety-second cooldown that lengthens after the sixth impression of a session, hard cap of twelve, and any purchase buys a twenty-four-hour holiday. There is no ad network here — the placements are honest simulations, so the guardrails around them are real and testable.
- **Nothing owned is ever removed.** Keys and tickets above their cap convert to Coins instead of evaporating. A broken streak pauses at its last milestone.
- **Odds are published in-game**, in the settings sheet, because they should be.

## Accessibility

Vehicle identity is never colour-only: class silhouettes differ, facing reads from the windscreen and light strip, one-way arrows are shape-coded, slicks carry a texture, and ambulances keep a cream body and a red cross whatever livery is equipped. The VIP is marked three ways over — a breathing gold halo, a hard gold ring that survives every colourblind remap, and a badge carrying both a star and the word — so it is never the colour alone doing the work. Reduced motion holds the halo still and keeps the rest. On top of that sit three colourblind palette remaps, a high-contrast mode, reduced motion, three haptic levels, a left-handed layout, calm honks, and text scaling to 130% without layout breaks.

## Testing

`npm test` runs 127 unit tests: sim geometry and every modifier, solver optimality and dead-end detection, the full 320-level campaign audited for validity, solvability, par, band mix, gate compliance and difficulty scaling, plus the economy, medals, Metered-Lot gating and save layers.

The solvability audit is the one that makes the difficulty curve safe to move. Every one of the 320 lots is re-verified on each run to be clearable *and* clearable in exactly one slide per car — so packing them denser and knotting them deeper cannot quietly ship an unfair jam.

`npm run smoke` is the one that catches what unit tests cannot. It boots the real game in Chromium at phone resolution, clears levels by dispatching genuine pointer events, drags a blocked car to check it bumps rather than escapes, undoes a slide, opens a hint, plays a Night Shift lot, runs a Metered Lot dry to check the save-me appears and that declining lands on a breather, plays a level with the keyboard alone, walks every meta screen, and fails on any console error, page exception, failed request, stacked modal or empty screen.

`npm run firstrun` measures the opening: time from navigation to a touchable lot, and whether the guiding hand arrives after four seconds of hesitation and points at a car that can actually leave. On this machine it reports about 300 ms to touchable against the production build.

That figure is up from roughly 240 ms before the lot was textured, and the difference is real rather than noise — measured by rebuilding both versions and running the probe against each. It buys aggregate grain, weathering, the occlusion ring and the vignette, and it is paid once per lot rather than per frame. The two obvious wastes were removed once they were measured: the street apron no longer gets a grain pass it would only have overdrawn, and the grain is filled at CSS resolution and blitted up instead of being stamped per device pixel — nine times less fill at dpr 3, on noise that loses nothing to the upscale.

`npm run gallery` screenshots a spread of lots covering every vehicle class and modifier, plus the colourblind, high-contrast and Night Shift modes — the fastest way to see whether a rendering change reads at a glance.

`npm run journey` goes the long way round: it restores two districts through the UI, watches the timelapse, collects capped income, builds a landmark, buys and equips a livery, then screenshots every accessibility mode and three viewports down to 320px, failing on any sideways scroll. `npm run perf` reports frame times.

Both write screenshots to `/tmp/gridlock-shots` for eyeballing.

`window.__gridlock` exposes the live sim for that harness — which car can leave, where a cell lands on screen, and a `jumpTo(level)` that goes through the app rather than racing the save file.

## What is not here

This is the game, not the service. There is no backend, so anything that needs one is either absent or honestly labelled: Rush Hour shows a clear-rate *estimated from the jam's own measured shape* rather than a fabricated community figure, and the ad placements are simulations. The LiveOps modes that are fundamentally social — Ambulance Run leagues, the Motorcade community meter, Depot Crews, ghost solves, friends' Rush Hour stamps — need a server to mean anything, so they are not stubbed in. Cloud save, remote config, attribution and the analytics pipeline are the same story: covered by the design document, out of scope for a client.

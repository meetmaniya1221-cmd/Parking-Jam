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

Every lot is an integer grid. Every vehicle is an axis-aligned segment with a facing, and it moves only along that facing — forward or back. Reach a curb cut and it commits and drives off. Blocked, it honks, wobbles, and flashes the car that said no; the bump costs nothing. The puzzle is never *can I move this car*, it is *can I read the order*. Clear the lot and the district earns a little more of itself back.

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

**`generator.ts` (JamForge)** builds lots **backwards**, by inverse moves from an empty lot. *Un-exit* parks a car where it could drive straight off and records that exit as the next-latest move. *Un-slide* hauls a car already on the lot back along its lane and records the shunt. The construction therefore *is* a solution, replayed in reverse: every generated jam is solvable by algorithm rather than by hoping a search confirms it afterwards.

**`campaign.ts`** describes 320 launch jams rather than storing them. A global level index determines band, pattern, grid size, car count and modifier load, plus a full difficulty vector — knot depth, minimum solution length, opening width, bottleneck count, how many shunts the line must contain, and how much of the lot must survive the tapping bot. JamForge turns that into the same lot on every device, every time. The whole sequence costs zero bundle bytes and every number in it is a tunable.

### The thing that made the old jams easy

Cars only ever *leave* this lot. Nothing is added, so removing a car strictly frees cells, and every move legal before an exit is still legal after it. Two things follow, and they turned out to be the whole story:

- **Taking a free exit is never a mistake.** Delete a car's moves from any optimal line and what remains is still legal.
- So **a lot that can be cleared by exits alone can be cleared by tapping cars in any order at all.** There is nothing to get wrong.

The old generator only ever placed cars that could drive straight off, which made every lot exactly that kind of lot. Measured on the shipped campaign: the bot that repeatedly taps whatever car happens to be free cleared **100% of all 320 jams**, whatever their car count, blocker density or knot depth. Difficulty was a spot-the-open-lane exercise wearing a puzzle's clothes.

The fix is not more cars. It is the **cycle**: car A parked across car E's lane while E is parked across A's. Neither can leave, no ordering saves it, and the knot opens only when somebody is shunted sideways — a move that gets that car no closer to its own exit and exists purely to make room. That move is the one thing a player can get wrong, so it is the only place difficulty can live.

Three consequences fell out of it, each one a constraint the old design had backwards:

1. **A lot needs all four edges open before a loop is possible at all.** With curb cuts on only two edges, give every car its remaining distance to the streets that exist: standing in someone's way always means standing *ahead* of them, so every arrow in the dependency graph points from a smaller number to a larger one. No loop can exist, so something can always leave. A third edge does not fix it — the same argument runs on the remaining axis. Narrow frontage is now the *simplicity* lever it always secretly was.
2. **Density past about half the lot removes the puzzle.** A car needs an empty cell in its own lane before it can be shunted anywhere. The old lots ran at three-quarters full, where nothing can reposition. Car counts came down by roughly a fifth.
3. **Cars that block nobody are furniture, not distractors.** They come off in one tap and the lot is exactly as it was, so they are pruned outright rather than tolerated. Every shipped jam now has zero of them.

Generation is **generate → replay-verify → measure → judge → regenerate**, and the judging happens twice: once on the constructed line, which is free, and again on the shortest line the solver can find, for the candidates still in contention. That second pass matters more than it sounds. Knots that share cars come undone together, so a lot built with six interlocks can still have a one-shunt solution — only the post-solve number says what the player cannot avoid.

### The curve: a ten-level on-ramp, then it bites

Levels 1–3 teach the verb, 4–9 add vocabulary at a standard difficulty, and **level 10 is where the game stops being gentle** — a stretch jam on a 7×9 lot: twelve cars, a knot ten deep, two shunts the solver cannot avoid, and eight of those twelve still standing after every free exit has been taken. It is a step rather than a slope, and it is meant to be felt.

| Levels 5+ | Breather | Standard | Stretch | Showcase |
|---|---|---|---|---|
| Jams | 42 | 93 | 169 | 12 |
| Cars | 13.6 | 13.8 | 14.3 | 16.5 |
| Knot depth | 7.9 | 8.0 | 8.0 | 8.9 |
| Par moves | 14.6 | 15.2 | 15.7 | 18.2 |
| Shunts the solver cannot avoid | 1.1 | 1.4 | 1.4 | 1.7 |
| Still standing when tapping runs dry | 44% | 51% | 53% | 67% |

Every lever has to move together, and that is the part worth writing down. Knot depth past four links needs a chain that turns corners; a corner needs a crossing lane with its own curb cut; so the grid and the street frontage are the *ceiling* on depth, not decoration alongside it. Asking a 5×6 lot with two open edges for a knot of nine produces a lot of six, silently. The grid therefore jumps to 7×9 at level 10, every lot past the on-ramp fronts onto four streets, and the full puzzle vocabulary — blockers, one-ways, oil, VIPs, ambulances, roundabouts, gates — is open by level 18 instead of level 60.

Stretch is now the default texture of a chapter at 53% rather than its peak at 20%, but breathers survive at 18%. They are rest, not easy — the level-21 breather still holds two fifths of its lot back from tapping and still needs a shunt to open. What makes it a rest is that it shows you four cars ready to drive off, where the stretch jam either side of it shows you one or none. A curve with no let-up in it reads as a wall.

Depth is deliberately *not* asserted to climb era over era, for two reasons. An era's mean depth tracks how many breathers it happens to contain — L10–20 has almost none, later districts run two apiece — so measured that way a climb would be measuring band mix. And depth genuinely plateaus: a 7×10 lot with a dozen cars tops out around eight or nine links whatever the spec asks for. The late campaign holds that plateau and climbs on the axis that still has room, which is how much repositioning the knot demands.

`npm run test` prints the delivered curve on every run (`tests/curve.report.test.ts`). That readout is not decoration: difficulty here is *requested* by the spec and *delivered* by the generator, and the two are not the same number.

### A finding worth writing down

Counting how many cars are free on move one is not a difficulty measurement. It looks like one — a jam showing you six open lanes plainly *reads* easier than one showing you a wall — but since taking a free exit is never a mistake, those cars come off the lot whatever their number and whatever order you pick. It measures how a jam looks, not what it asks.

What it does measure sits one move later. `greedyClearance` runs the tapping bot to exhaustion and reports what is left standing; that number is the puzzle. On the old campaign it was zero everywhere. It is now a third to a half of the lot, and it is what the bands are graded on.

The second trap was believing the difficulty knobs were independent. They are not, and three of them are hard gates on whether the lot can be a puzzle at all rather than dials on how hard it is: four open edges (or no loop can exist), roughly half-empty (or nothing can be shunted), and a curb frontage wide enough that the patch served by all four directions is a solid block rather than a sliver. Miss any of them and the generator produces a lot that looks knotted, measures knotted on every static metric, and unties itself the moment a player taps it.

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
| Metered Lot | Sprinkled from L45 | The only fail state, and the only save-me. Capped slides, always with slack above par, never on a mechanic's first five outings and never on a skill-check. Held at L45 deliberately while the puzzle vocabulary moved earlier — difficulty was worth front-loading, a fail state was not. |
| Rush Hour | Daily | One authored hard jam, one attempt, the same for everyone. |
| Cold Cases | From L70 | Every retired daily, replayable and untimed. |
| Night Shift | Tuesdays | The same reads by headlight only. 1.5× Miles. |
| Overtime Shifts | From L80 | A rotating set of ten rated jams a day, endlessly. |
| Gridlock Gauntlet | Monthly | Twelve escalating rungs on one continuous path, with three checkpoint chests. A checkpoint is a place to stop, not only to carry on. |

## Design commitments that are enforced in code, not just intended

- **Every jam is solvable unaided.** Guaranteed by construction in the generator, and re-verified for all 320 levels on every test run.
- **No jam falls to reflex.** The tapping bot clears none of the 316 jams past the on-ramp, and `tests/dependency.test.ts` fails the build if a single one starts to.
- **Every car has a job.** No shipped jam contains a car that blocks nobody and could drive off whenever it liked.
- **A mistake costs nothing.** Bumps are free and diagnostic. One-way arrows and oil slicks make some slides irreversible, so there is an unlimited **Undo**, and when a lot really has been knotted for good the game notices and says so rather than letting the player grind at it.
- **A session never ends on a failure.** Running a Metered Lot dry offers the save-me; declining it hands the player a guaranteed-solvable breather, not a loss screen.
- **Never more than one modal deep.** The win screen does not stack an offer on top of itself; the pinch offer and the interstitial are mutually exclusive, and the smoke test fails the build if two overlays are ever open at once.
- **Interstitials, exactly as specified.** Never before level 12, only on the way out of a win screen, ninety-second cooldown that lengthens after the sixth impression of a session, hard cap of twelve, and any purchase buys a twenty-four-hour holiday. There is no ad network here — the placements are honest simulations, so the guardrails around them are real and testable.
- **Nothing owned is ever removed.** Keys and tickets above their cap convert to Coins instead of evaporating. A broken streak pauses at its last milestone.
- **Odds are published in-game**, in the settings sheet, because they should be.

## Accessibility

Vehicle identity is never colour-only: class silhouettes differ, facing reads from the windscreen and light strip, one-way arrows are shape-coded, slicks carry a texture, and ambulances keep a cream body and a red cross whatever livery is equipped. On top of that sit three colourblind palette remaps, a high-contrast mode, reduced motion, three haptic levels, a left-handed layout, calm honks, and text scaling to 130% without layout breaks.

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

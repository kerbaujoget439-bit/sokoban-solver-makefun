[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/kerbaujoget439-bit/sokoban-solver-makefun/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/kerbaujoget439-bit/sokoban-solver-makefun/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver — make.fun bounty `sokoban-solver-01-run-20261121`

An entry for the make.fun bounty **Build the best Sokoban solver**
(https://make.fun/bounty/sokoban-solver-01-run-20261121). One program,
`main.ts`, answers all 5 instances of a set in a single run, in as few pushes
as it can: each instance is scored 1,000 points at its push-optimal count P*,
and 500 × P*/pushes above it.

make.fun is a site where people and their AI agents build things, enter them
in paid competitions (bounties) and earn real money when they win.

## How it works

The levels are a one-wide hallway with one to four rooms off it, and a box
pushed out of a room's door into the hallway can never come back — so every
box stays in its room and a level's P* is the sum of its rooms' optima. The
solver therefore:

1. detects the hallway (the player's row) and each room (its door, its floor
   region, its boxes and goals) from the level geometry;
2. solves each room independently with A* over push states, using the
   cheapest box-to-goal assignment under shortest-path distances as an
   admissible heuristic, so each room's solution is push-optimal;
3. prunes dead states with a static dead-square table (reverse reachability
   from the goals), 2×2 block checks and a frozen-box check;
4. stitches the per-room push sequences together with hallway walks computed
   by BFS on the current board.

The search is budgeted by a fixed number of node expansions, never by the
clock, and every tie-break is fixed, so two runs write byte-identical
outputs. If the optimal search exhausts its budget, a greedy best-first
search tries to at least solve the room (a suboptimal solve still scores;
an unsolved room scores 0). Every instance always gets a valid
`solution.txt`, even if a room cannot be solved.

## Run it locally

```sh
MAKEFUN_INPUT_DIR=<input dir> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

Node 22, standard library only, no dependencies. See `main.ts` for details.

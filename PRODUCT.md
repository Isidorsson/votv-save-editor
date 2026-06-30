# Product

## Register

product

## Users

Voices of the Void players and modders editing their own `.sav` files on PC.
They're technical enough to find `%localappdata%`, comfortable with the game's
systems (signals, upgrades, inventory), and want to tweak a save (give points,
max upgrades, swap items) without a hex editor. Context: at their desk, game
closed, making a deliberate change then jumping back in.

## Product Purpose

A safe, in-browser editor for VotV save files. It parses the raw GVAS save,
exposes the values worth changing (points, survival stats, upgrades, inventory,
equipment) behind clear controls, and writes a valid save back. Success = the
user makes the edit they wanted, the game loads the result, nothing corrupts.
Everything is client-side; no save ever leaves the machine.

## Brand Personality

Operator-console: precise, legible, quietly atmospheric. Three words:
**instrument, trustworthy, signal**. It should feel like the diagnostic console
of the facility you run in-game — dark, focused, a green signal pulse — not a
neon hacker toy and not a sterile form.

## Anti-references

- Generic "hacker terminal" cliché (matrix rain, all-caps green-on-black noise,
  fake CRT scanlines everywhere).
- Bootstrap/SaaS settings page with flat gray cards in a grid.
- Over-rounded, glassmorphic, drop-shadow-everything dashboard.

## Design Principles

- **Trust is the feature.** Every destructive path is reversible (backup) and
  every write is verified before download. The UI must make safety legible.
- **Show the real value.** Surface actual field names/values, never fake-friendly
  abstractions that hide what's being written to the save.
- **Calm density.** Lots of fields, but grouped and paced so the eye lands on the
  few things most people change first.
- **The tool disappears.** Familiar controls, no invented affordances; the
  atmosphere is mood, never friction.

## Accessibility & Inclusion

Target WCAG 2.1 AA: body text ≥4.5:1, focus-visible rings on every control,
full keyboard operation (including the item picker), and a
`prefers-reduced-motion` path for all motion.

# pokelister

Pipeline privé de listing Pokémon en volume. Scanner ADF → identification → pricing → eBay + TCGplayer.

## Ordre de lecture

1. `CLAUDE.md` — contexte projet, invariants, conventions. Lu par Claude Code à chaque session.
2. `PROMPTS.md` — la séquence de build, un prompt par session.
3. `docs/` — la spec détaillée, référencée par les prompts.

## Avant de coder

Les étapes 0 et 1 de `PROMPTS.md` sont des expériences manuelles, pas du code.
Le design du matching et du pricing dépend de leurs résultats.

# pokelister

Pipeline privé de listing Pokémon en volume. Photos → identification → pricing →
eBay + TCGplayer. Un seul utilisateur, une seule machine.

---

## Démarrer

**Double-clique `Demarrer.bat`.**

Il vérifie la configuration, construit l'application, lance les deux process et ouvre
le navigateur. `Arreter.bat` coupe tout.

Il affiche aussi une adresse réseau (`http://192.168.x.x:3000`) : l'app est accessible
depuis n'importe quel appareil de la maison — téléphone, tablette — pour reviewer
ailleurs que devant le PC.

**Prérequis, une seule fois :** copier `.env.example` en `.env.local` et renseigner
`DATABASE_URL`.

---

## Les écrans

| | À quoi ça sert |
|---|---|
| **Envoyer** | Déposer un lot de photos. Recto-verso par défaut. |
| **Lots** | Ce que devient chaque envoi. Fermeture avec réconciliation. |
| **Review** | Identifier ce que la machine n'a pas su résoudre. Tout au clavier. |
| **Inventaire** | Ce que tu possèdes. Recherche, filtres, valeur totale. |
| **Prix** | Éditer la grille tarifaire avec preview en direct et net après frais. |
| **Diagnostic** | Le taux de lecture OCR par ère — l'expérience 1bis, en continu. |
| **Santé** | Cinq métriques. Si c'est vert, tu peux aller dormir. |

**La review est la page qui compte.** C'est le seul endroit où le système coûte du
temps humain. Tout s'y fait au clavier — `?` affiche les raccourcis.

---

## Le flux

```
photos ──► /upload ──► appariement recto/verso ──► empreintes + embedding
                                                          │
                                    ┌─────────────────────┴──────────────┐
                                    │  niveau 1  empreintes connues      │
                                    │  niveau 2  OCR + catalogue + CLIP  │
                                    │  niveau 3  /review (humain)        │
                                    └─────────────────────┬──────────────┘
                                                          ▼
                                              inventaire (SKU, qté)
                                                          │
                                              pricing ────┴──── canaux
```

**Le variant se décide à l'envoi, pas après.** Une photo à plat ne permet pas de
distinguer un reverse holo d'un normal, et l'écart de prix va de 5 à 20 fois. Trie tes
reverse holos à part et fais-en un lot séparé.

---

## Commandes

```bash
pnpm dev                 # développement, rechargement à chaud
pnpm build && pnpm start # production locale
pnpm test                # 164 tests
pnpm typecheck

node --import tsx worker/index.ts   # le worker, à part
```

> **Jamais `npx tsx` pour le worker.** Ctrl+C tue le wrapper npx, pas le process node :
> le worker survit, continue de surveiller le dossier, et produit des résultats
> incohérents qu'on met du temps à comprendre.

### Données

```bash
pnpm seed:catalog        # 20 444 cartes depuis pokemon-tcg-data
pnpm seed:embeddings     # embeddings CLIP, ~25 cartes/s
pnpm reset:data --confirm  # efface scans/inventaire/lots, GARDE le catalogue
pnpm backup              # sauvegarde + vérification immédiate
pnpm loadtest 2000 200   # test de charge, worker en parallèle
pnpm golden:export       # constitue le golden set depuis les reviews faites
```

---

## Où lire quoi

1. `CLAUDE.md` — invariants et non-objectifs. **À lire avant de toucher au code.**
2. `docs/01-architecture-and-data-model.md` — schéma complet
3. `docs/02-ingest-and-matching.md` — le cœur du système
4. `docs/03-pricing.md`, `docs/04-channels.md`
5. `docs/05-production.md` — observabilité, tests, sauvegardes
6. `docs/06-ui.md` — système visuel
7. `docs/07-premier-test.md` — **ce que tu fais au premier vrai lot**
8. `docs/runbooks.md` — quand ça casse
9. `PROMPTS.md` — l'ordre de build et les expériences

---

## État

**Fait :** ingestion (dossier surveillé et upload), appariement recto/verso, empreintes
pHash/dHash, embeddings CLIP sur 20 392 cartes, résolution à trois niveaux, UI de review,
pricing complet, export TCGplayer, observabilité, sauvegarde restaurable.

**Mesuré :** 61,7 cartes/minute en charge, 205 Mo au pic, 0 job mort sur 2 000 scans.

**En attente de données réelles :**

- Les taux de frais eBay sont des **placeholders non vérifiés** (`lib/config/fees.ts`).
  Le net affiché est étiqueté comme estimation.
- `fetchEbayComps()` rend une liste vide : la source de ventes passées dépend de
  l'expérience 1. `estimateValue` retombe sur TCGplayer seul, ce qui est correct.
- `tcg_sku_id` est vide : ces IDs ne s'obtiennent qu'en exportant le catalogue
  TCGplayer. Sans eux, l'export CSV écarte toutes les lignes — visiblement, avec la
  raison.
- Le golden set est vide : la porte de non-régression du matching **n'est pas active**
  tant qu'il n'y a pas 200 scans étiquetés. `pnpm golden:export` les récolte au fil des
  reviews.

**Ce que ce système ne fera jamais** — voir `CLAUDE.md` §7. Chaque ligne est une
décision prise, pas un manque à combler.

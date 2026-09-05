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
| **Envoyer** | **Glisser le dossier du scanner.** Recto-verso par défaut. |
| **Lots** | Ce que devient chaque envoi. Fermeture avec réconciliation. |
| **Review** | Identifier ce que la machine n'a pas su résoudre. Tout au clavier. |
| **Vérifier** | Auditer ce que la machine a décidé seule, et corriger. |
| **Inventaire** | Ce que tu possèdes. Recherche, filtres, valeur totale. |
| **Prix** | Éditer la grille tarifaire avec preview en direct et net après frais. |
| **Diagnostic** | Le taux de lecture OCR par ère — l'expérience 1bis, en continu. |
| **Santé** | Huit métriques. Si c'est vert, tu peux aller dormir. |

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
pnpm verify              # typecheck + tests + build + les 9 pages rendues
pnpm dev                 # développement, rechargement à chaud
pnpm build && pnpm start # production locale
pnpm test                # 381 tests
pnpm typecheck

node --import tsx worker/index.ts   # le worker, à part
```

> **`pnpm smoke` charge vraiment les neuf pages.** Il existe parce que `/pricing` a
> renvoyé 500 pendant deux étapes complètes avec un build vert : un build qui
> compile n'est pas une page qui charge.

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

### Répétitions

Elles traversent les **vrais chemins HTTP**, contrairement au test de charge qui
dépose dans l'inbox. Elles écrivent dans la base : `pnpm reset:data --confirm`
après. L'application et le worker doivent tourner.

```bash
pnpm repetition 40       # 80 pages, appariement, réconciliation exacte
pnpm edge                # dix formats de scanner, dont deux fichiers corrompus
pnpm course              # six envois SIMULTANÉS vers le même lot
pnpm seed:volume 15000   # remplit la base au volume cible (--purge pour effacer)
```

⚠ `pnpm seed:volume` écrit beaucoup. Pense à `--purge` : c'est en oubliant
l'équivalent que la base est passée en lecture seule le 5 septembre.

---

## Où lire quoi

1. `CLAUDE.md` — invariants et non-objectifs. **À lire avant de toucher au code.**
2. `docs/01-architecture-and-data-model.md` — schéma complet
3. `docs/02-ingest-and-matching.md` — le cœur du système
4. `docs/03-pricing.md`, `docs/04-channels.md`
5. `docs/05-production.md` — observabilité, tests, sauvegardes
6. `docs/06-ui.md` — système visuel
7. `docs/07-premier-test.md` — **ce que tu fais au premier vrai lot**
8. `docs/08-nuit-du-5-septembre.md` puis `docs/09-matinee-du-5-septembre.md` —
   ce qui a changé, et les vingt-six pannes trouvées **en exécutant**
9. `docs/runbooks.md` — quand ça casse
10. `PROMPTS.md` — l'ordre de build et les expériences

---

## État

**Fait :** ingestion (dossier surveillé et upload), appariement recto/verso, empreintes
pHash/dHash, embeddings CLIP sur 20 392 cartes, résolution à trois niveaux, UI de review,
pricing complet, export TCGplayer, observabilité, sauvegarde restaurable.

**Mesuré :** 80 cartes/minute sur un lot réel, 400 pages uploadées en 8 s, mémoire du
worker stable entre 500 et 800 Mo sur 800 cartes, 0 job mort. À 15 000 SKUs et
15 000 scans, les neuf pages rendent entre 6 et 303 ms. Niveau 1 sur 120 000
empreintes : 45 à 62 ms.

**Limite connue :** le quota de base du plan gratuit Supabase est de **500 Mo**, et
`known_fingerprints` gagne une ligne d'environ 2,9 ko par scan résolu. Cela donne
trois à cinq mois avant que la base passe en lecture seule — auquel cas le pipeline
s'arrête net. Le tableau de santé surveille la taille et avertit à 80 %.

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

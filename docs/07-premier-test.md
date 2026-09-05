# 07 — Le premier test réel

Ce que tu fais la première fois que tu passes de vraies cartes, et **ce que tu
regardes**. L'ordre compte : chaque étape produit une donnée dont la suivante dépend.

Prévois environ deux heures, dont une d'attente pendant que le worker travaille.

---

## Avant de commencer

```bash
pnpm reset:data --confirm     # repart propre, garde le catalogue
```

Puis double-clique `Demarrer.bat`. Vérifie que `/dashboard` est vert avant d'aller
plus loin — s'il y a déjà une alarme, elle ne viendra pas de ton test.

---

## Test 1 — Un petit lot, pour vérifier que la chaîne tient

**50 cartes, un seul variant, toutes de la même ère.** Prends du moderne : c'est là que
l'OCR marche le mieux, donc c'est le meilleur cas et il doit passer.

1. Scanne en recto-verso. Tu dois obtenir **100 fichiers** `image0001`… `image0100`.
2. `/upload` — nomme le lot, choisis le variant, coche **Recto-verso**, dépose tout.
3. `/batches` — tu dois voir **50 cartes**, pas 100. Si tu en vois 100, l'appariement
   n'a pas fonctionné et il faut s'arrêter là.
4. Saisis **50** dans le champ « attendu ». C'est ce qui rend la réconciliation possible.
5. Attends que la barre d'avancement se vide de gris.

**Ce que tu regardes :**

| Où | Quoi | Ce que ça veut dire |
|---|---|---|
| `/batches` | 50 cartes, pas 100 | l'appariement recto/verso fonctionne |
| `/batches` | aucune anomalie en haut | aucune page perdue, aucun décalage |
| `/diagnostics` | taux de lecture OCR | **le chiffre le plus important du test** |
| `/dashboard` | jobs morts = 0 | rien n'a échoué en silence |

---

## Test 2 — Le chiffre qui décide de la suite

Sur `/diagnostics`, lis le **taux de numéro lu**.

- **Au-dessus de 85 %** — le niveau 2 tient. Continue.
- **En dessous** — regarde la ventilation par ère avant toute conclusion. Si une seule
  tranche décroche, c'est un problème de crop, pas de conception : la colonne « bande de
  crop qui a réussi » dit laquelle utiliser. Si tout décroche, c'est la qualité des
  photos qu'il faut regarder d'abord — cadrage, netteté du bloc numéro, contraste.

C'est la décision de l'expérience 1bis, et elle gouverne l'étape 3 du plan de build.

> **Attention à un piège de lecture.** Les cartes non résolues n'ont pas d'ère connue
> — l'ère vient du set, et le set vient de l'identification. Elles tombent dans « date
> inconnue ». Ce n'est pas un bug de la page : c'est que le taux par ère se lit sur ce
> qui a été résolu, et le taux global sur tout.

---

## Test 3 — La review, chronométrée

`/review`. Appuie sur `?` une fois pour voir les raccourcis, puis **n'utilise plus la
souris**.

Le compteur en haut à droite affiche **s/carte** en direct. C'est la mesure qui compte :
le budget est de 3 secondes.

**Ce que tu cherches :**

- Les candidats proposés sont-ils les bons ? Si le bon candidat n'est jamais dans la
  liste, le problème est en amont — OCR ou embeddings.
- Le champ « Numéro lu » explique-t-il les échecs ? C'est lui qui distingue « l'OCR n'a
  rien lu » de « l'OCR a lu, mais CLIP a mal départagé ».
- Combien de fois dois-tu ouvrir la recherche (`S`) ? Chaque recours est un échec des
  deux premiers niveaux.

---

## Test 4 — La boucle d'apprentissage

C'est le mécanisme économique du système, et il se vérifie en cinq minutes.

1. **Repasse les mêmes cartes** dans le scanner, envoie-les comme un second lot.
2. `/batches` — elles devraient se résoudre **presque instantanément**, en
   `own_history`.

Le test de charge a montré que **le taux global est entièrement déterminé par le taux à
la première occurrence** : une carte résolue une fois l'est pour toujours, une carte qui
échoue échoue à chaque fois tant qu'un humain ne l'a pas reviewée. La duplication
n'améliore rien toute seule — elle amplifie.

**Si le second lot ne se résout pas en `own_history`, quelque chose ne va pas** dans
l'écriture des empreintes, et c'est grave : c'est ce qui fait tendre le coût vers zéro.

---

## Test 5 — Le pricing sur de vraies cartes

Une fois des cartes en inventaire, le cron horaire les prixe. Pour ne pas attendre :

```sql
insert into jobs (type, payload, idempotency_key)
values ('price_refresh', '{"limit":50}', 'manuel-' || now()::text);
```

Puis `/inventory`, filtre **Sans prix**.

**Ce que tu regardes :**

- Combien restent sans prix, et pourquoi. Une carte sans donnée TCGplayer est normale ;
  beaucoup de cartes sans donnée ne l'est pas.
- Sur `/pricing`, la colonne **Net eBay**. À 1,75 $ avec 1 $ de port il reste
  **12 cents**. Regarde combien de tes cartes atterrissent au plancher : c'est
  l'expérience 1ter, et si la part est grande, la lane « lot » n'est pas une option mais
  une nécessité de conception.

---

## Test 6 — Le volume

Quand les cinq premiers tests passent, envoie **un vrai lot de plusieurs centaines de
cartes** et laisse tourner.

**Ce que tu regardes pendant :**

- `/dashboard` — la profondeur de file monte puis redescend. Les jobs morts restent à 0.
- La mémoire du process worker ne monte pas indéfiniment (205 Mo mesurés sur 2 000
  scans).

**Après :** `pnpm backup` puis `pnpm backup:verify`. Un backup jamais restauré n'est pas
un backup, et c'est le moment de le savoir — pas le jour où tu en as besoin.

---

## Ce qui ne marchera pas, et c'est normal

- **Aucun prix eBay réel.** `fetchEbayComps()` rend une liste vide tant que la source de
  ventes passées n'est pas choisie (expérience 1). Le pricing tourne sur TCGplayer seul.
- **Le net affiché est une estimation.** Les taux de frais sont des placeholders, marqués
  comme tels à l'écran, tant que tu ne les as pas relevés dans le Seller Hub.
- **L'export TCGplayer écarte tout.** `tcg_sku_id` est vide : ces IDs ne s'obtiennent
  qu'en exportant leur catalogue. L'export le dit ligne par ligne au lieu de produire un
  fichier vide sans explication.
- **La porte de non-régression du matching est inactive.** Le golden set est vide.
  `pnpm golden:export` le constitue à partir de tes reviews : après 200 cartes reviewées
  à la main, elle s'active et protège les seuils.

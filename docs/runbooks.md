# Runbooks

Ce que tu fais quand ça casse, avec les commandes qui existent vraiment dans ce repo.
Dérivé de `docs/05-production.md` §6, ajusté à ce que le système fait aujourd'hui.

**Le réflexe de départ, toujours le même :** ouvre `/dashboard`. Cinq métriques, chacune
avec son seuil affiché. Si elle est verte, le problème est ailleurs que dans le pipeline.

---

## 0. Commandes de base

```bash
node --import tsx worker/index.ts   # démarre le worker (PAS `npx tsx` — voir plus bas)
pnpm dev                            # UI : /dashboard, /review, /pricing
pnpm test                           # 120 tests, dont la porte du chemin de l'argent
pnpm backup                         # sauvegarde + vérification immédiate
pnpm backup:verify 2026-09-05       # revérifie une sauvegarde existante
pnpm loadtest 2000 200              # test de charge, worker en parallèle
```

> **Ne lance jamais le worker avec `npx tsx`.** `Ctrl+C` tue le wrapper npx, pas le
> process node : le worker survit, continue de surveiller `inbox/` et ingère des
> fichiers pendant que tu crois l'avoir arrêté. C'est arrivé pendant le
> développement et ça produit des résultats incohérents qu'on met du temps à
> comprendre. Utilise `node --import tsx`.

Pour tuer un worker fantôme :

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match "worker[/\\]index" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

## 1. « La file monte et ne redescend pas »

```sql
-- 1. Quel type est bloqué ?
select type, status, count(*) from jobs group by 1,2 order by 3 desc;

-- 2. Une erreur domine-t-elle ?
select last_error, count(*) from jobs
 where status = 'failed' group by 1 order by 2 desc limit 10;
```

**Si une seule erreur domine, c'est systémique : arrête le worker avant de brûler du
quota.** Le circuit breaker limite la casse mais ne remplace pas un diagnostic.

**Si l'erreur est un 429 ou un 5xx**, le circuit devrait déjà être ouvert. Les jobs
concernés sont repoussés *sans consommer de tentative* — c'est voulu : une panne de
vingt minutes ne doit pas produire une montagne de `dead` à rejouer à la main.

**Si des jobs sont coincés en `running`** alors qu'aucun worker ne tourne, c'est un
worker mort en cours de route. `reclaimStale()` s'en occupe au démarrage et chaque
minute, avec un bail de 10 minutes. Pour forcer :

```sql
update jobs set status='queued', locked_by=null, locked_at=null
 where status='running' and locked_at < now() - interval '10 minutes';
```

---

## 2. « Une session ne se ferme pas » (écart de comptage)

Écart entre `expected_count` (compteur du scanner) et `scanned_count` =
**double-alimentation probable**.

```sql
select name, expected_count, scanned_count, expected_count - scanned_count as ecart
  from sessions where status = 'open' and expected_count <> scanned_count;

-- Trous dans la numérotation : les seq manquants
select generate_series(1, (select max(seq) from scans where session_id = $1)) as attendu
except
select seq from scans where session_id = $1;
```

1. **Ne ferme pas la session.**
2. Repasse physiquement la pile.
3. Compare les `seq` présents pour localiser les trous.
4. Si l'écart persiste, la pile est **physiquement recomptée avant tout listing**.

Ne contourne jamais cette vérification. Une carte fantôme dans l'inventaire finit en
commande non honorable, et le problème est silencieux par nature : la carte existe dans
ta boîte mais n'a aucune ligne. Tu ne la vends pas, tu ne la retrouves jamais.

---

## 3. « Des prix aberrants sont partis »

```sql
-- Ce qui a bougé, avec le raisonnement complet
select sku, price, reason, breakdown, created_at
  from price_history where created_at > now() - interval '24 hours'
    and reason = 'reprice' order by created_at desc;

-- Ce que le garde-fou a déjà bloqué
select sku, payload, created_at from channel_events
 where event = 'price_swing' order by created_at desc limit 50;
```

Le garde-fou refuse tout mouvement de plus de 40 % en un cycle et n'écrit pas le
nouveau prix. Si des prix aberrants sont quand même passés, c'est qu'ils étaient sous
ce seuil — donc probablement une dérive lente, pas un accident de source.

1. Identifier la source fautive via `breakdown` (il contient les poids et les valeurs
   brutes de chaque source).
2. Rollback : republier depuis `price_history` la valeur précédente des SKUs touchés.
3. **Ajouter un cas à `tests/pricing.test.ts`** pour le pattern rencontré. Sans ça il
   reviendra.

`price_history.breakdown` est ce qui rend ce runbook exécutable. Ne l'allège jamais.

---

## 4. « Le taux de review manuelle a doublé »

C'est la métrique économique principale : le seul coût marginal par carte qui reste, et
il se paie en minutes. Causes par ordre de probabilité :

```sql
-- Répartition dans le temps
select date_trunc('day', created_at) as jour, match_source, count(*)
  from scans group by 1,2 order by 1 desc;
```

1. **Un nouveau set n'est pas dans `cards`.** Relance `pnpm seed:catalog` puis
   `pnpm seed:embeddings` — un set présent sans embeddings ne sert à rien, le rerank
   CLIP porte plus de la moitié du volume.
2. **Les réglages du scanner ont changé.** Compare `sessions.scanner_profile` entre une
   session saine et une session dégradée.
3. **L'OCR décroche sur une ère.** Le bloc numéro n'est pas au même endroit selon
   l'époque : à gauche sur le moderne, à droite sur le vintage. Les bandes essayées
   sont dans `THRESHOLDS.ocr.bands`.
4. **Les seuils ont été touchés.** `tests/golden.test.ts` est censé l'empêcher — mais il
   ne protège rien tant que le jeu de fixtures est vide, et il le dit à chaque
   exécution.

---

## 5. « J'ai perdu des données »

```bash
pnpm backup:verify 2026-09-05          # la sauvegarde est-elle lisible ?
npx tsx scripts/backup.ts restore 2026-09-05
```

La restauration est **rejouable** (`on conflict do nothing`) et l'ordre des tables
respecte les clés étrangères. L'aller-retour complet — écrire, sauvegarder, effacer,
restaurer, comparer — est couvert par `tests/backup.test.ts`, y compris la
réinjection des `bit(64)` et des `vector(512)`, qui est le point qui casse en pratique.

Ce qui n'est **pas** sauvegardé parce que reconstructible : `cards` et
`card_embeddings` (`pnpm seed:catalog` puis `pnpm seed:embeddings`), `price_current`
(refetchable), les images.

---

## 6. « L'API de prix est en panne »

Attendu et géré. `pokemontcg.io` renvoie régulièrement du 500/502 — mesuré à 4 échecs
sur 5 sur l'endpoint par identifiant, ce qui est la raison pour laquelle on interroge
en lot par la forme requête.

Le circuit s'ouvre après 10 échecs consécutifs et se referme au bout de 5 minutes. Rien
à faire : les jobs sont repoussés sans consommer de tentative. Vérifie simplement que le
`dead` du dashboard reste à zéro.

Si la panne dure des heures, arrête le cron plutôt que de laisser la file gonfler :

```sql
delete from jobs where type = 'price_refresh' and status in ('queued','failed');
```

Le prochain tic horaire réenfilera un batch propre.

---

## 7. « La base est passée en lecture seule »

Symptôme : tout échoue sur `cannot execute INSERT in a read-only transaction`.
Le worker meurt, les envois échouent, l'inventaire ne bouge plus. **Le pipeline
est arrêté**, ce n'est pas un ralentissement.

Cause : le plan gratuit Supabase plafonne la **base de données** à 500 Mo. Au-delà,
Supabase coupe les écritures. Le tableau de santé avertit à 80 % — si on en est
là, c'est qu'on ne l'a pas regardé.

Le piège de la sortie de secours : il faut les deux commandes **dans la même
session** SQL. Le `set` seul ne suffit pas, et une session neuve repart en lecture
seule.

```sql
-- Dans UNE seule session (l'éditeur SQL Supabase, ou un seul psql).
set session characteristics as transaction read write;
set statement_timeout = 0;

-- Faire de la place. Par ordre de gain :
delete from jobs where status = 'done' and created_at < now() - interval '7 days';
delete from channel_events where event like 'api\_%' and created_at < now() - interval '7 days';
vacuum full jobs;
vacuum full channel_events;

select pg_size_pretty(pg_database_size(current_database()));
```

Le `vacuum full` est indispensable : sans lui l'espace reste réservé et la base
reste en lecture seule. Vérifier ensuite dans une session **neuve** que
`show default_transaction_read_only` vaut `off`.

Si ça ne suffit pas, la seule table qui reste grosse est `known_fingerprints`, et
**on ne la vide pas** : c'est des mois de review manuelle. C'est le moment de
passer au plan Pro.

---

## 8. « Un lot reste à zéro carte »

Symptôme : les photos sont parties, `/upload` dit même « ce lot contient déjà
N pages », et `/batches` affiche zéro carte.

Cause : la finalisation de l'envoi — le `PUT` qui enfile l'appariement — a échoué.
Les fichiers sont sur le disque, aucun job n'existe.

Sur `/batches`, bouton **Réparer** → « Apparier recto-verso ». Rejouer est sans
danger : les pages déjà rattachées à un scan sont ignorées.

Si le lot est **fermé**, l'action refuse : son comptage est déjà réconcilié.
Rouvrir d'abord, en connaissance de cause.

---

## 9. « Le worker ne démarre pas »

Le lanceur écrit son journal dans `logs/worker.log` et affiche les dernières
lignes s'il détecte que le worker est mort. Les deux causes, par ordre de
fréquence :

1. **`.env.local` absent ou `DATABASE_URL` faux.** Le worker charge ce fichier
   lui-même depuis le 5 septembre — avant, il ne le faisait pas et mourait
   silencieusement dans une fenêtre réduite.
2. **Le projet Supabase est en pause.** Le plan gratuit met en pause après une
   semaine d'inactivité. Le réveiller depuis le tableau de bord Supabase.

Et si `Demarrer.bat` répond « pokelister tourne déjà » : c'est voulu. Un second
worker écraserait des pages, parce que l'appariement alloue ses numéros d'ordre
par `max(seq) + 1`, ce qui n'est sûr qu'à un seul processus. `Arreter.bat` avant
de relancer.


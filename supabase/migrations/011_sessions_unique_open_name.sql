-- Un seul lot OUVERT par nom.
--
-- POURQUOI. `openSession` faisait « select puis insert ». Deux requêtes
-- concurrentes ne trouvent rien, toutes les deux insèrent, et le lot existe en
-- double. Mesuré le 5 septembre 2026 : six envois simultanés vers le même nom de
-- lot ont créé **cinq lignes de session**.
--
-- Les conséquences se cumulent, et aucune ne se voit :
--
--   - les scans se répartissent entre plusieurs sessions du même nom, donc
--     `/batches` affiche plusieurs lignes pour un seul lot physique ;
--   - `scanned_count` est réparti lui aussi, donc la réconciliation compare un
--     comptage attendu à une fraction des cartes — le contrôle qui existe
--     précisément pour rattraper une carte perdue devient faux ;
--   - `page_count` étant par session, l'allocation atomique des rangs de
--     fichiers repart de zéro dans chaque session, et les pages s'écrasent.
--
-- L'index est PARTIEL sur `status = 'open'` : réutiliser le nom d'un lot fermé
-- des mois plus tard reste légitime. Le répertoire d'upload est en revanche
-- nommé d'après le lot, pas d'après son identifiant — d'où le `max()` avec le
-- rang présent sur le disque, côté application, qui empêche d'écraser les
-- fichiers de l'ancien lot dans ce cas.

-- Un doublon préexistant empêcherait la création de l'index. On garde le plus
-- ancien de chaque nom — celui qui porte les scans — et on ferme les autres au
-- lieu de les supprimer : une ligne de lot ne se supprime pas plus qu'une ligne
-- d'inventaire.
update sessions s
   set status = 'closed', closed_at = now()
 where s.status = 'open'
   and exists (
     select 1 from sessions t
      where t.name = s.name
        and t.status = 'open'
        and t.opened_at < s.opened_at
   );

create unique index if not exists sessions_open_name
  on sessions (name)
  where status = 'open';

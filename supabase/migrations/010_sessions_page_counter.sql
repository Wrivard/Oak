-- Compteur de pages déposées, par lot.
--
-- POURQUOI. Le rang des fichiers uploadés était calculé en LISANT LE
-- RÉPERTOIRE au début de chaque requête. C'était déjà la correction d'un bug
-- antérieur — se fier au décalage annoncé par le client faisait écraser les
-- fichiers d'un premier envoi par un second — mais elle laisse une course
-- ouverte :
--
--   POST A lit le répertoire        -> base 0
--   POST B lit le répertoire        -> base 0        (A n'a encore rien écrit)
--   A écrit 000001..000010
--   B écrit 000001..000010          -> les dix pages de A sont écrasées
--
-- Le client envoie ses paquets en série, donc ça ne peut pas arriver depuis un
-- seul onglet. Mais deux onglets, ou deux dossiers envoyés en parallèle, y
-- suffisent — et le résultat est le pire mode de défaillance du système : des
-- cartes physiquement scannées sans aucune ligne d'inventaire, sans message.
--
-- Ce compteur s'incrémente par `update ... returning`, donc atomiquement : deux
-- requêtes concurrentes reçoivent des plages disjointes. Le rang effectif reste
-- le MAXIMUM entre ce compteur et ce que porte le disque, pour qu'un répertoire
-- rempli par un autre chemin — l'ancien watcher, une restauration de fichiers —
-- ne soit jamais écrasé non plus.
--
-- Il compte des PAGES, pas des cartes : en recto-verso, deux pages font une
-- carte. `scanned_count` reste le compteur de cartes de la réconciliation.

alter table sessions
  add column if not exists page_count integer not null default 0;

comment on column sessions.page_count is
  'Pages déposées par upload. Allocation atomique du rang de fichier, pas un compte de cartes.';

-- Les lots existants portent déjà des fichiers : on part de ce que dit le
-- disque au premier envoi suivant, grâce au maximum côté application.

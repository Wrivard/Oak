-- 007 — ce que l'OCR a lu
--
-- Le handler `match` lit déjà le bloc numéro et jette le résultat. Le garder
-- coûte deux colonnes et donne LA donnée de l'expérience 1bis de PROMPTS.md :
-- le taux de lecture correcte du X/Y, ventilé par ère, sur de VRAIS scans.
--
-- Sans ça, diagnostiquer «pourquoi cette carte est partie en review» oblige à
-- rejouer le pipeline à la main.

alter table scans
  add column ocr_read       text,      -- "27/197", "SWSH284", null si rien lu
  add column ocr_confidence numeric(5,2),
  -- Quelle bande de THRESHOLDS.ocr.bands a donné la lecture retenue. C'est ce
  -- qui dira s'il faut un crop era-aware, et laquelle privilégier.
  add column ocr_band       int;

-- Le taux de lecture se calcule par ère en joignant sur cards.set_release ;
-- l'index sert les requêtes de diagnostic sur les scans non résolus.
create index scans_ocr on scans (ocr_read) where status = 'needs_review';

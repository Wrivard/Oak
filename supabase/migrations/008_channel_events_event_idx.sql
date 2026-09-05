-- 008 — index sur le type d'événement
--
-- `channel_events` mélange deux natures : l'historique métier (ventes,
-- mouvements de quantité, price_swing) et la télémétrie d'appels externes.
-- À 25-50k cartes/mois elle atteint des centaines de milliers de lignes, et
-- toute requête qui filtre par `event` sans index fait un Seq Scan complet.
--
-- Mesuré à 326 lignes : 0,4 ms, invisible. Le problème n'apparaît qu'au volume,
-- et c'est exactement pour ça qu'on met l'index avant d'y arriver.

create index channel_events_event on channel_events (event, created_at desc);

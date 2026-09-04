-- 006 — mouvements de quantité
-- Voir docs/01-architecture-and-data-model.md, migration 006.
--
-- Invariant 2 de CLAUDE.md : ne fais JAMAIS qty_on_hand = $new.
-- Toujours un delta atomique, jamais de read-modify-write.

create or replace function apply_qty_delta(
  p_sku text, p_delta int, p_reason text
) returns int language plpgsql as $$
declare
  new_qty      int;
  new_reserved int;
begin
  update inventory
     set qty_on_hand      = qty_on_hand + p_delta,
         -- Clamp de la réservation TCG dans le MÊME update. Les deux colonnes
         -- bougent atomiquement, donc qty_alloc_sane ne peut pas être violée par
         -- une vente eBay légitime. Voir la note en bas de fichier.
         qty_reserved_tcg = least(qty_reserved_tcg, greatest(qty_on_hand + p_delta, 0)),
         updated_at       = now(),
         -- Une vente TCG vient de TCGplayer : la repousser serait un aller-retour
         -- inutile. Tout autre mouvement rend la ligne sale.
         tcg_dirty        = case when p_reason = 'tcg_sale' then tcg_dirty else true end
   where sku = p_sku
  returning qty_on_hand, qty_reserved_tcg into new_qty, new_reserved;

  if not found then
    raise exception 'sku % introuvable', p_sku;
  end if;

  insert into channel_events (channel, sku, event, qty_delta, payload)
  values ('internal', p_sku, p_reason, p_delta,
          jsonb_build_object('new_qty', new_qty, 'new_reserved_tcg', new_reserved));

  return new_qty;
end $$;

-- La contrainte check (qty_on_hand >= 0) fait le reste : une vente concurrente qui
-- ferait passer sous zéro échoue au niveau base, pas au niveau applicatif.
--
-- Pourquoi le clamp. qty_alloc_sane (qty_reserved_tcg <= qty_on_hand) est correcte
-- comme invariant mais fausse comme garde : qty 7, on réserve 2 pour TCGplayer,
-- 5 ventes eBay passent — on est à qty 2 / reserved 2, et la 6e vente eBay légitime
-- violerait la contrainte. Un vrai encaissement de vente ne doit jamais être refusé
-- par la base. Le clamp abaisse la réservation en même temps que le stock ; le job
-- d'export TCGplayer voit la nouvelle réservation au prochain passage et repousse la
-- quantité. Une réservation est une intention, pas une promesse.

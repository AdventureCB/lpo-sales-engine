-- Older orders carry retired SKUs / shorter titles ("Gear Vault" vs today's
-- "Gear Vault (with 2 tables)"). Add a last fallback: the shortest product
-- whose title starts with the line's title.
create or replace function shop_resolve_lines()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with target as (
    select l.id,
      coalesce(
        l.product_id,
        (select p.id from shop_products p where l.sku is not null and l.sku <> '' and p.skus @> array[l.sku] order by p.id limit 1),
        (select p.id from shop_products p where l.title is not null and lower(p.title) = lower(l.title) order by p.id limit 1),
        (select p.id from shop_products p where l.title is not null and length(l.title) >= 6
           and lower(p.title) like lower(l.title) || ' %' order by length(p.title), p.id limit 1)
      ) as rid
    from shop_order_lines l
  )
  update shop_order_lines l set resolved_product_id = t.rid
  from target t
  where t.id = l.id and l.resolved_product_id is distinct from t.rid;
  get diagnostics n = row_count;
  return n;
end $$;

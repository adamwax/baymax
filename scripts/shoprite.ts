#!/usr/bin/env bun
// ShopRite from Home cart (NJ kitchen), driven from the meal plan. Calls the
// site's own storefront gateway (Wynshop) inside Adam's logged-in Chrome, with
// the session it already has: the bearer token from the oidc.user cookie, the
// store (MI9_RSID, 496 = Mullica Hill) and shopping mode (pickup/delivery).
// Foods map to products via foods.json `shoprite: { sku, g, name }`.
//
// usage: bun run shoprite search <terms>                 # find a SKU to map
//        bun run shoprite show                           # what's in the cart
//        bun run shoprite cart [--from d] [--dry-run]    # add `plan groceries` (Buy list), idempotent
//        bun run shoprite add <food> <packs>             # one product by hand (only raises)
//        bun run shoprite set <food> <packs>             # exact quantity, 0 removes
// Checkout (pickup slot, payment) stays in the ShopRite app.

import { join } from "node:path";
import { type Food, compute, load, today, totals } from "./kitchen";
import { groceries, type PlanDay } from "./plan";

export type ShopRiteSku = { sku: string; g: number; name: string };
type CartLine = { sku: string; name: string; quantity: number; price?: string };

const SITE = "https://www.shoprite.com";
// Shopping-mode ids are the same fixed GUIDs on every Wynshop store (v1/stores/{id}/shoppingmodes).
const PRELUDE = String.raw`
const C=Object.fromEntries(document.cookie.split(';').map(x=>{const i=x.indexOf('=');return [decodeURIComponent(x.slice(0,i).trim()),decodeURIComponent(x.slice(i+1))]}));
const U=JSON.parse(C[Object.keys(C).find(k=>k.startsWith('oidc.user'))]||'{}');
if(!U.access_token)throw new Error('not logged in');
const RSID=C.MI9_RSID;
const MODE={pickup:'11111111-1111-1111-1111-111111111111',delivery:'22222222-2222-2222-2222-222222222222'}[C.MI9_SHOPPING_MODE]??'11111111-1111-1111-1111-111111111111';
const H=(x={})=>({Authorization:'Bearer '+U.access_token,'X-Site-Host':'${SITE}','x-customer-session-id':C.CUSTOMER_SESSION_ID_COOKIE,'X-Shopping-Mode':MODE,...x});
const G='https://storefrontgateway.shoprite.com/api/';
const get=async(p,h)=>{const r=await fetch(G+p,{headers:H(h)});return r.ok?r.json():{status:r.status}};
const post=async(model,body)=>{const r=await fetch(G+'stores/'+RSID+'/cart',{method:'POST',headers:H({'Content-Type':'application/vnd.cart.v1+json;domain-model='+model,'X-Site-Location':'baymax'}),body:JSON.stringify(body)});if(!r.ok)throw new Error(model+' '+r.status+' '+(await r.text()).slice(0,300));};
// No cart yet is a 404, not an error: it's empty until the first add creates it.
const lines=async()=>((await get('stores/'+RSID+'/cart',{'X-Site-Location':'client/getCart'})).lineItems??[]).map(l=>({sku:l.sku,name:l.name,quantity:l.quantityValue,price:l.totalPrice}));`;

/** Run an async JS body in a shoprite.com tab; the body's return value comes back as JSON. */
function inChrome<T>(body: string): T {
  const file = `/tmp/baymax-shoprite-${process.pid}.js`;
  require("node:fs").writeFileSync(file, `window.__bx=null;(async()=>{try{${PRELUDE}\n${body}}catch(e){return {error:String(e)}}})().then(r=>window.__bx=JSON.stringify(r));'ok'`);
  const as = `
set js to read POSIX file "${file}" as «class utf8»
tell application "Google Chrome"
  -- Any window: the front one changes under us (a Meet window, say), so hold the tab by id.
  set t to missing value
  repeat with w in windows
    repeat with x in tabs of w
      if t is missing value and URL of x starts with "${SITE}" then set t to tab id (id of x) of w
    end repeat
  end repeat
  if t is missing value then
    set t to make new tab at end of tabs of window 1 with properties {URL:"${SITE}/"}
    delay 10
  end if
  execute t javascript js
  repeat 120 times
    set r to execute t javascript "window.__bx === null ? '' : window.__bx"
    if r is not "" then return r
    delay 1
  end repeat
  return "{\\"error\\":\\"timed out\\"}"
end tell`;
  const p = Bun.spawnSync(["osascript", "-"], { stdin: Buffer.from(as) });
  const out = JSON.parse(p.stdout.toString().trim() || `{"error":${JSON.stringify(p.stderr.toString())}}`);
  if (out?.error) throw new Error(`ShopRite: ${out.error} (logged in to shoprite.com in Chrome?)`);
  return out;
}

export const readCart = () => inChrome<CartLine[]>("return await lines();");

export const search = (q: string) =>
  inChrome<{ sku: string; name: string; price: string }[]>(
    `return ((await get('stores/'+RSID+'/search?q='+encodeURIComponent(${JSON.stringify(q)})+'&take=10&skip=0')).items??[]).map(i=>({sku:i.sku,name:i.name,price:i.price}));`,
  );

/** Set absolute quantities. By default never lowers what's in the cart; `exact` sets it as given (0 removes). */
export function setCart(want: { sku: string; quantity: number }[], exact = false) {
  return inChrome<CartLine[]>(`
const have=Object.fromEntries((await lines()).map(l=>[l.sku,l.quantity]));
for(const w of ${JSON.stringify(want)}){
  const h=have[w.sku]??0;
  if(${exact}?h===w.quantity:h>=w.quantity)continue;
  if(!h)await post('AddProductLineItemToCart',{quantity:w.quantity,sku:w.sku,source:{type:'catalog'},shoppingModeId:MODE});
  else if(w.quantity===0)await post('RemoveLineItemFromCart',{LineItemId:'sku:'+w.sku});
  else await post('SetLineItemQuantity',{lineItemId:'sku:'+w.sku,quantity:w.quantity});
}
return await lines();`);
}

/** Packs to buy for each Buy-list row: whole packs of the mapped product, or why it was skipped. */
export function packs(rows: ReturnType<typeof groceries>, foods: Map<string, Food>) {
  const want: { sku: string; quantity: number; food: string }[] = [];
  const skipped: string[] = [];
  for (const r of rows) {
    const p = (foods.get(r.id) as Food & { shoprite?: ShopRiteSku }).shoprite;
    if (!r.tracked) skipped.push(`${r.name}: never counted (check the kitchen first)`);
    else if (!p) skipped.push(`${r.name}: no ShopRite product (bun run shoprite search …, then map it in foods.json)`);
    else want.push({ sku: p.sku, quantity: Math.ceil(r.buy / p.g), food: r.id });
  }
  return { want, skipped };
}

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const flag = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  const dry = rest.includes("--dry-run");
  const { dir, foods, events, nutrition } = await load();
  const print = (cart: { sku: string; quantity: number; name?: string; price?: string }[]) => {
    const bySku = new Map([...foods.values()].filter((f) => (f as any).shoprite).map((f) => [(f as any).shoprite.sku as string, f]));
    for (const c of cart) console.log(`  ${c.quantity} × ${c.name ?? (bySku.get(c.sku) as any)?.shoprite.name ?? c.sku}${c.price ? `  ${c.price}` : ""}${bySku.has(c.sku) ? "" : "  (not a mapped food)"}`);
    const total = cart.reduce((s, c) => s + Number(c.price?.replace(/[^\d.]/g, "") || 0), 0);
    if (total) console.log(`  ≈ $${total.toFixed(2)} before fees and tax`);
  };

  if (!cmd || cmd === "show") {
    print(readCart());
  } else if (cmd === "search") {
    for (const r of search(rest.join(" "))) console.log(`  ${r.sku}  ${r.name}  ${r.price}`);
  } else if (cmd === "cart" || cmd === "add" || cmd === "set") {
    let want: { sku: string; quantity: number }[];
    if (cmd !== "cart") {
      const f = foods.get(rest[0]!) as (Food & { shoprite?: ShopRiteSku }) | undefined;
      if (!f?.shoprite) throw new Error(`${rest[0]} has no ShopRite product in foods.json (add a shoprite: {sku, g, name})`);
      want = [{ sku: f.shoprite.sku, quantity: Number(rest[1] ?? 1) }];
    } else {
      const plan: { days: PlanDay[] } = await Bun.file(join(dir, "mealplan.json")).json();
      const { lots } = compute(events, nutrition, foods);
      const rows = groceries(plan.days.filter((d) => d.date >= (flag("--from") ?? today())), foods, totals(lots), new Set(events.map((e) => e.food!).filter(Boolean)));
      const p = packs(rows, foods);
      for (const s of p.skipped) console.log(`skip ${s}`);
      want = p.want;
    }
    if (dry) print(want);
    else print(setCart(want, cmd === "set"));
  } else {
    console.error(`unknown command "${cmd}" (see the header of scripts/shoprite.ts)`);
    process.exit(1);
  }
}

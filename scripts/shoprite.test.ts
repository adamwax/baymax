import { expect, test } from "bun:test";
import { packs } from "./shoprite";

const foods = new Map<string, any>([
  ["fage-0", { id: "fage-0", name: "Fage", shoprite: { sku: "00689544083016", g: 907, name: "Fage 32 oz" } }],
  ["grapes", { id: "grapes", name: "Grapes" }],
  ["honey", { id: "honey", name: "Honey", shoprite: { sku: "00073260000073", g: 454, name: "Honey 16 oz" } }],
]);
const row = (id: string, buy: number, tracked = true) => ({ id, name: foods.get(id).name, tracked, need: buy, have: 0, buy, packs: undefined });

test("buy list becomes whole packs; unmapped and never-counted foods are skipped with a reason", () => {
  const { want, skipped } = packs([row("fage-0", 2050), row("honey", 15), row("grapes", 400)], foods);
  expect(want).toEqual([
    { sku: "00689544083016", quantity: 3, food: "fage-0" },
    { sku: "00073260000073", quantity: 1, food: "honey" },
  ]);
  expect(skipped).toEqual(["Grapes: no ShopRite product (bun run shoprite search …, then map it in foods.json)"]);
  expect(packs([row("fage-0", 100, false)], foods).skipped[0]).toContain("never counted");
});

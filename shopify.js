/**
 * Shopify Admin API helpers for Siya Ayurveda: products and draft orders.
 */
import fetch from "node-fetch";
import { SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN } from "./config.js";

const API_VERSION = "2024-01";
const BASE = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}`;

function headers() {
  return {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
  };
}

export async function getProducts(limit = 20, query = "") {
  if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
    return { products: [], error: "Shopify not configured" };
  }
  const url = `${BASE}/products.json?limit=50`;
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { products: [], error: `Shopify: ${res.status}` };
  const data = await res.json();
  let products = (data.products || []).map((p) => ({
    id: p.id,
    title: p.title,
    body_html: (p.body_html || "").slice(0, 200),
    variants: (p.variants || []).map((v) => ({
      id: v.id,
      title: v.title,
      price: v.price,
      sku: v.sku,
    })),
  }));
  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    products = products.filter((p) => p.title.toLowerCase().includes(q));
  }
  return { products: products.slice(0, limit) };
}

export async function getProductById(id) {
  if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) return { product: null, error: "Shopify not configured" };
  const res = await fetch(`${BASE}/products/${id}.json`, { headers: headers(), signal: AbortSignal.timeout(10000) });
  if (!res.ok) return { product: null, error: `Shopify: ${res.status}` };
  const data = await res.json();
  const p = data.product;
  if (!p) return { product: null, error: "Not found" };
  return {
    product: {
      id: p.id,
      title: p.title,
      body_html: (p.body_html || "").slice(0, 300),
      variants: (p.variants || []).map((v) => ({ id: v.id, title: v.title, price: v.price, sku: v.sku })),
    },
  };
}

/**
 * Create a draft order. lineItems: [{ variant_id, quantity }], shipping_address: { first_name, last_name, address1, city, province, country, zip, phone }
 */
export async function createDraftOrder({ lineItems, shippingAddress, note = "" }) {
  if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
    return { draft_order: null, error: "Shopify not configured" };
  }
  const body = {
    draft_order: {
      line_items: lineItems.map((item) => ({
        variant_id: item.variant_id,
        quantity: Math.max(1, parseInt(item.quantity, 10) || 1),
      })),
      shipping_address: shippingAddress,
      note: note || "Order via Siya Ayurveda voice assistant (Neha)",
    },
  };
  const res = await fetch(`${BASE}/draft_orders.json`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.text();
    return { draft_order: null, error: `Shopify: ${res.status} ${err}` };
  }
  const data = await res.json();
  return { draft_order: data.draft_order, error: null };
}

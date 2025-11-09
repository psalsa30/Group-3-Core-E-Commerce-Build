// server/index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";

const app = express();

// --- CORS (works with Safari/Chrome on any localhost port)
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / Postman
    if (/^http:\/\/localhost:\d+$/.test(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "Origin"],
};
app.use(cors(corsOptions));

// Generic preflight for Express
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// Tiny logger
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});

const prisma = new PrismaClient();

// --- Health
app.get("/", (_req, res) => res.send("UniThrift API ✅"));

// --- Seed products with descriptions
app.get("/api/seed", async (_req, res) => {
  const count = await prisma.product.count();
  if (count > 0) return res.json({ ok: true, count, message: "Products already seeded" });
  
  await prisma.product.createMany({
    data: [
      { 
        name: "GE Book: Ethics", 
        description: "Lightly used GE book. Minimal highlights. Perfect for Term 2.",
        price: 120, 
        campus: "ADMU", 
        category: "Books", 
        imageUrl: "https://picsum.photos/seed/book/400/300" 
      },
      { 
        name: "A4 Bond Paper (500s)", 
        description: "Brand new, sealed pack. Great for printing reports.",
        price: 180, 
        campus: "ADMU", 
        category: "School Supplies", 
        imageUrl: "https://picsum.photos/seed/paper/400/300" 
      },
      { 
        name: "Preloved Hoodie", 
        description: "Size M. Slight fading but very comfy. No holes.",
        price: 130, 
        campus: "ADMU", 
        category: "Preloved", 
        imageUrl: "https://picsum.photos/seed/hood/400/300" 
      },
      { 
        name: "Wired Earphones", 
        description: "Working condition. Good bass. Includes case.",
        price: 150, 
        campus: "UPD", 
        category: "Gadgets", 
        imageUrl: "https://picsum.photos/seed/ear/400/300" 
      },
      { 
        name: "Calculus Textbook", 
        description: "Complete with solution manual. Barely used.",
        price: 200, 
        campus: "ADMU", 
        category: "Books", 
        imageUrl: "https://picsum.photos/seed/calc/400/300" 
      },
      { 
        name: "Wireless Mouse", 
        description: "Logitech M170. Battery included. Works perfectly.",
        price: 180, 
        campus: "UPD", 
        category: "Gadgets", 
        imageUrl: "https://picsum.photos/seed/mouse/400/300" 
      },
    ],
  });
  
  res.json({ ok: true, message: "Products seeded successfully" });
});

// --- Products endpoint
app.get("/api/products", async (req, res) => {
  try {
    const { campus, category, priceMin, priceMax } = req.query;
    const where = {};
    
    if (campus) where.campus = campus;
    if (category) where.category = category;
    if (priceMin || priceMax) {
      where.price = {
        gte: priceMin ? Number(priceMin) : undefined,
        lte: priceMax ? Number(priceMax) : undefined,
      };
    }
    
    const products = await prisma.product.findMany({ 
      where, 
      take: 60,
      orderBy: { createdAt: 'desc' }
    });
    
    res.json(products);
  } catch (e) {
    console.error("Products fetch error:", e);
    res.status(500).json({ error: "Failed to fetch products", message: String(e?.message) });
  }
});

// --- Estimate (OpenRouteService; falls back if no key/error)
const COORDS = {
  "SEC-A Lobby": [121.07793, 14.64068],
  "Gate 2.5": [121.07888, 14.6418],
  "Regis": [121.07496, 14.63995],
  "Katipunan LRT": [121.07309, 14.63909],
  "AS Steps": [121.0647, 14.6547],
  "Shopping Center": [121.0657, 14.653],
  "Sunken Garden": [121.0644, 14.6536],
  "Main Gate": [120.989, 14.6096],
  "Quadricentennial Park": [120.9898, 14.6101],
  "Beato Library": [120.9904, 14.6092],
};

app.get("/api/estimate", async (req, res) => {
  try {
    const { from, to } = req.query;
    const start = COORDS[from];
    const end = COORDS[to];
    
    if (!start || !end) {
      return res.status(400).json({ error: "Unknown pickup point" });
    }

    // Try OpenRouteService API if key is available
    if (process.env.ORS_API_KEY) {
      try {
        const r = await fetch("https://api.openrouteservice.org/v2/directions/foot-walking/geojson", {
          method: "POST",
          headers: {
            Authorization: process.env.ORS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ coordinates: [start, end] }),
        });
        
        if (r.ok) {
          const data = await r.json();
          const meters = data.features?.[0]?.properties?.summary?.distance ?? 500;
          const minutes = Math.ceil((data.features?.[0]?.properties?.summary?.duration ?? 600) / 60);
          const fee = 10 + Math.ceil(meters / 100) * 0.5;
          return res.json({ meters, minutes, fee: Math.ceil(fee) });
        }
      } catch (err) {
        console.log("ORS API failed, falling back to estimate");
      }
    }
    
    // Graceful fallback with reasonable estimates
    const fallbackEstimates = {
      meters: 500,
      minutes: 10,
      fee: 20,
      note: "Estimated values (API unavailable)"
    };
    
    res.json(fallbackEstimates);
    
  } catch (e) {
    console.error("Estimate error:", e);
    res.status(500).json({ error: "Failed to calculate estimate" });
  }
});

// --- Checkout (with payment info support)
app.post("/api/cart/checkout", async (req, res) => {
  try {
    console.log("POST /api/cart/checkout body:", req.body);

    const campus = (req.body?.campus || "ADMU").toString();
    const pickup = (req.body?.pickup || "Gate 2.5").toString();
    const paymentMethod = (req.body?.paymentMethod || "gcash").toString();
    const gcashNumber = (req.body?.gcashNumber || "").toString();

    // Accept multiple payload shapes
    let items = [];
    if (Array.isArray(req.body)) items = req.body;
    else if (Array.isArray(req.body?.items)) items = req.body.items;
    else if (Array.isArray(req.body?.cart)) items = req.body.cart;

    // Normalize items (support both 'id' and 'productId', 'qty' and 'quantity')
    const norm = (items || []).map(i => ({
      productId: String(i.productId || i.id || i.name || "").trim(),
      qty: Number(i.qty ?? i.quantity ?? 1),
      priceSnap: Number(i.price ?? 0),
    }));

    // Validate items
    if (norm.length === 0) {
      return res.status(422).json({
        error: "No items received",
        hint: "Check Content-Type: application/json and request body shape",
        received: req.body
      });
    }

    // Try to fetch DB prices; fall back to snapshot
    const ids = norm.filter(i => i.productId).map(i => i.productId);
    const found = await prisma.product.findMany({ 
      where: { id: { in: ids } } 
    });
    const priceMap = Object.fromEntries(found.map(p => [p.id, p.price]));

    // Calculate total
    const total = norm.reduce((sum, i) => {
      const dbPrice = Number.isFinite(priceMap[i.productId]) ? priceMap[i.productId] : null;
      const unit = dbPrice ?? (Number.isFinite(i.priceSnap) ? i.priceSnap : 0);
      const qty = Number.isFinite(i.qty) && i.qty > 0 ? i.qty : 1;
      return sum + unit * qty;
    }, 0);

    // Create order with payment info
    const order = await prisma.order.create({
      data: {
        campus,
        pickup,
        paymentMethod,
        gcashNumber: paymentMethod === "gcash" ? gcashNumber : null,
        total: Math.max(0, Math.round(total)),
        items: {
          create: norm.map(i => ({
            productId: i.productId || "UNKNOWN",
            qty: Number.isFinite(i.qty) && i.qty > 0 ? i.qty : 1,
            price: Number.isFinite(priceMap[i.productId])
              ? priceMap[i.productId]
              : (Number.isFinite(i.priceSnap) ? i.priceSnap : 0),
          }))
        }
      },
      include: {
        items: true
      }
    });

    return res.json({ 
      orderId: order.id, 
      total: order.total,
      paymentMethod: order.paymentMethod,
      pickup: order.pickup,
      itemCount: order.items.length
    });

  } catch (e) {
    console.error("Checkout server error:", e);
    return res.status(500).json({ 
      error: "Checkout failed", 
      message: String(e?.message || e) 
    });
  }
});

// --- Get order details (optional, for confirmation page)
app.get("/api/orders/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true }
    });
    
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    
    res.json(order);
  } catch (e) {
    console.error("Order fetch error:", e);
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(`✅ UniThrift API server running`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`🌱 Seed data: http://localhost:${PORT}/api/seed`);
});
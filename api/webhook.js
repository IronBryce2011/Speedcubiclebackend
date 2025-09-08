import { buffer } from 'micro';
import Stripe from 'stripe';
import { Pool } from 'pg';

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const buf = await buffer(req);
  let event;

  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email;
    let items = [];

    try {
      if (session.metadata?.items) {
        items = JSON.parse(session.metadata.items);
        console.log('✅ Parsed items from metadata:', items);
      }
    } catch (e) {
      console.error('❌ Failed to parse metadata.items:', e.message);
    }

    let total = 0;
    for (const item of items) {
      const { rows } = await pool.query('SELECT price, stock FROM products WHERE id=$1', [item.id]);
      if (!rows[0]) {
        console.warn(`⚠️ Product ${item.id} not found`);
        continue;
      }
      total += rows[0].price * item.quantity;
      await pool.query('UPDATE products SET stock = stock - $1 WHERE id=$2', [item.quantity, item.id]);
      console.log(`🔻 Stock updated for product ${item.id}`);
    }

    await pool.query(
      'INSERT INTO orders(email, products, total, status) VALUES($1, $2, $3, $4)',
      [email, JSON.stringify(items), total, 'paid']
    );

    console.log(`✅ Order saved for ${email}`);
  }

  res.json({ received: true });
}

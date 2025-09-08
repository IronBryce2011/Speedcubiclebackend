const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');

const app = express();

// ---- Database ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---- Stripe Client ----
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Stripe Webhook (before express.json) ----
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email;
    let items = [];

    // Try to parse items from metadata
    try {
      if (session.metadata?.items) {
        items = JSON.parse(session.metadata.items);
      }
    } catch (e) {
      console.error('Failed to parse items from metadata:', e.message);
    }

    // 🔁 Fallback: Look up most recent order by email
    if (items.length === 0 && email) {
      try {
        const { rows } = await pool.query(
          'SELECT products FROM orders WHERE email=$1 ORDER BY id DESC LIMIT 1',
          [email]
        );
        if (rows.length > 0) {
          items = JSON.parse(rows[0].products);
          console.log('Recovered items from DB fallback:', items);
        }
      } catch (err) {
        console.error('Fallback DB lookup failed:', err.message);
      }
    }

    // ✅ Proceed with stock update and order insert
    let total = 0;
    for (const item of items) {
      const { rows } = await pool.query(
        'SELECT price, stock FROM products WHERE id=$1',
        [item.id]
      );

      if (!rows[0]) {
        console.warn(`Product ${item.id} not found during webhook stock update`);
        continue;
      }

      total += rows[0].price * item.quantity;
      await pool.query(
        'UPDATE products SET stock = stock - $1 WHERE id=$2',
        [item.quantity, item.id]
      );
      console.log(`Webhook: decremented stock for product ${item.id} by ${item.quantity}`);
    }

    await pool.query(
      'INSERT INTO orders(email, products, total, status) VALUES($1, $2, $3, $4)',
      [email, JSON.stringify(items), total, 'paid']
    );

    // Send confirmation email (fire-and-forget)
    sendConfirmationEmail(email, { items, total });
  }

  res.json({ received: true });
});

// ---- Middleware ----
app.use(
  cors({ origin: 'https://speedcubicle.vercel.app' })
);
app.use(express.json()); // parse JSON bodies

// ---- Utility: Send confirmation email ----
async function sendConfirmationEmail(to, orderDetails) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: '"Rubik\'s Cube Store" <store@example.com>',
      to,
      subject: 'Order Confirmation',
      html: `
        <h1>Thank you for your purchase!</h1>
        <p>Order details:</p>
        <pre>${JSON.stringify(orderDetails, null, 2)}</pre>
      `
    });
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ---- Products Endpoints ----
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products');
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error fetching products' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM products WHERE id=$1',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error fetching product' });
  }
});

// ---- Direct Orders Endpoint ----
app.post('/api/orders', async (req, res) => {
  const { email, items, paymentMethodId } = req.body;
  if (!email || !items || items.length === 0 || !paymentMethodId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Calculate total & check stock
    let total = 0;
    for (const item of items) {
      const { rows } = await pool.query(
        'SELECT price, stock FROM products WHERE id=$1',
        [item.id]
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: `Product ${item.id} not found` });
      }
      if (rows[0].stock < item.quantity) {
        return res.status(400).json({
          error: `Not enough stock for product ${item.id}`
        });
      }
      total += rows[0].price * item.quantity;
    }

    // Charge with Stripe
    await stripe.paymentIntents.create({
      amount: Math.round(total * 100),
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true
    });

    // Update stock
    for (const item of items) {
      await pool.query(
        'UPDATE products SET stock = stock - $1 WHERE id=$2',
        [item.quantity, item.id]
      );
      console.log(`API order: decremented stock for product ${item.id} by ${item.quantity}`);
    }

    // Save order
    const { rows: orderRows } = await pool.query(
      'INSERT INTO orders(email, products, total, status) VALUES($1, $2, $3, $4) RETURNING *',
      [email, JSON.stringify(items), total, 'paid']
    );

    sendConfirmationEmail(email, orderRows[0]);

    res.json({ success: true, order: orderRows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error processing order' });
  }
});

// ---- Stripe Checkout Session Endpoint ----
app.post('/api/create-checkout-session', async (req, res) => {
  const { email, items } = req.body;
  const line_items = items.map(item => ({
    price_data: {
      currency: 'usd',
      product_data: { name: item.name || `Product ${item.id}` },
      unit_amount: Math.round((item.price || 10) * 100)
    },
    quantity: item.quantity
  }));

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      customer_email: email,
      success_url: `${process.env.FRONTEND_URL}/success`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: {
        items: JSON.stringify(
          items.map(i => ({ id: i.id, quantity: i.quantity }))
        )
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Create session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Export App ----
module.exports = app;

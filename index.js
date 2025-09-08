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

// ---- Stripe ----
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Webhook (must be before express.json) ----
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email;
    let items = [];

    try {
      if (session.metadata?.items) {
        items = JSON.parse(session.metadata.items);
        console.log('Parsed items from metadata:', items);
      }
    } catch (e) {
      console.error('Failed to parse metadata.items:', e.message);
    }

    if (!items.length && email) {
      try {
        const { rows } = await pool.query(
          'SELECT products FROM orders WHERE email=$1 ORDER BY id DESC LIMIT 1',
          [email]
        );
        if (rows.length) {
          items = JSON.parse(rows[0].products);
          console.log('Recovered items via DB fallback:', items);
        }
      } catch (e) {
        console.error('Fallback DB lookup failed:', e.message);
      }
    }

    let total = 0;
    for (const item of items) {
      const { rows } = await pool.query('SELECT price, stock FROM products WHERE id=$1', [item.id]);
      if (!rows[0]) {
        console.warn(`Product ${item.id} not found, skipping`);
        continue;
      }
      total += rows[0].price * item.quantity;
      await pool.query('UPDATE products SET stock = stock - $1 WHERE id=$2', [item.quantity, item.id]);
      console.log(`Webhook: Product ${item.id} stock -${item.quantity}`);
    }

    await pool.query(
      'INSERT INTO orders(email, products, total, status) VALUES($1, $2, $3, $4)',
      [email, JSON.stringify(items), total, 'paid']
    );

    sendConfirmationEmail(email, { items, total });
  }

  res.json({ received: true });
});

// ---- Middleware ----
app.use(cors({ origin: 'https://speedcubicle.vercel.app' }));
app.use(express.json());

// ---- Email Utility ----
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
      html: `<h1>Thank you for your purchase!</h1><pre>${JSON.stringify(orderDetails, null, 2)}</pre>`
    });

    console.log(`Confirmation email sent to ${to}`);
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ---- Products ----
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products');
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error fetching products' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error fetching product' });
  }
});

// ---- Orders ----
app.post('/api/orders', async (req, res) => {
  const { email, items, paymentMethodId } = req.body;
  if (!email || !items?.length || !paymentMethodId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    let total = 0;
    for (const item of items) {
      const { rows } = await pool.query('SELECT price, stock FROM products WHERE id=$1', [item.id]);
      if (!rows[0]) return res.status(400).json({ error: `Product ${item.id} not found` });
      if (rows[0].stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for product ${item.id}` });
      total += rows[0].price * item.quantity;
    }

    await stripe.paymentIntents.create({
      amount: Math.round(total * 100),
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true
    });

    for (const item of items) {
      await pool.query('UPDATE products SET stock = stock - $1 WHERE id=$2', [item.quantity, item.id]);
      console.log(`API order: Product ${item.id} stock -${item.quantity}`);
    }

    const { rows: orderRows } = await pool.query(
      'INSERT INTO orders(email, products, total, status) VALUES($1, $2, $3, $4) RETURNING *',
      [email, JSON.stringify(items), total, 'paid']
    );

    sendConfirmationEmail(email, orderRows[0]);
    res.json({ success: true, order: orderRows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Error processing order' });
  }
});

// ---- Stripe Checkout Session ----
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { email, items } = req.body;

    const line_items = items.map(i => ({
      price_data: {
        currency: 'usd',
        product_data: { name: i.name || `Product ${i.id}` },
        unit_amount: Math.round((i.price || 0) * 100)
      },
      quantity: i.quantity
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      customer_email: email,
      success_url: `${process.env.FRONTEND_URL}/success`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: {
        items: JSON.stringify(items.map(i => ({ id: i.id, quantity: i.quantity })))
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe session creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Start Server ----
module.exports = app;

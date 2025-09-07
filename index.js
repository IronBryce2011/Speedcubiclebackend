 require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');

const app = express();
const pool = new Pool({
  user: process.env.DB_USER || 'your_db_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'your_db_name',
  password: process.env.DB_PASS || 'your_db_password',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432,
});

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Stripe Checkout session endpoint
app.post('/api/create-checkout-session', async (req, res) => {
  const { email, items } = req.body;
  const line_items = items.map(item => ({
    price_data: {
      currency: 'usd',
      product_data: { name: item.id }, // Replace with actual product name if available
      unit_amount: 1000, // Replace with actual price in cents
    },
    quantity: item.quantity,
  }));

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      customer_email: email,
      success_url: 'http://localhost:4200/success',
      cancel_url: 'http://localhost:4200/cancel',
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.use(bodyParser.json());

// ---- Utility: Send confirmation email ----
async function sendConfirmationEmail(to, orderDetails) {
  try {
    let transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    await transporter.sendMail({
      from: '"Rubik\'s Cube Store" <store@example.com>',
      to: to,
      subject: "Order Confirmation",
      html: `<h1>Thank you for your purchase!</h1>
             <p>Order details:</p>
             <pre>${JSON.stringify(orderDetails, null, 2)}</pre>`
    });
  } catch (err) {
    console.error("Email error:", err.message);
  }
}

// ---- Products ----
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products');
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error fetching products" });
  }
});

app.get('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: "Product not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error fetching product" });
  }
});

// ---- Orders ----
app.post('/api/orders', async (req, res) => {
  const { email, items, paymentMethodId } = req.body;
  if (!email || !items || items.length === 0 || !paymentMethodId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Calculate total
    let total = 0;
    for (let item of items) {
      const { rows } = await pool.query('SELECT price, stock FROM products WHERE id=$1', [item.id]);
      if (rows.length === 0) return res.status(400).json({ error: `Product ${item.id} not found` });
      if (rows[0].stock < item.quantity) return res.status(400).json({ error: `Not enough stock for product ${item.id}` });
      total += rows[0].price * item.quantity;
    }

    // Charge with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(total * 100), // cents
      currency: 'usd',
      payment_method: pm_card_visa,
      confirm: true
    });

    // Update stock and save order
    for (let item of items) {
      await pool.query('UPDATE products SET stock = stock - $1 WHERE id=$2', [item.quantity, item.id]);
    }
    const { rows: orderRows } = await pool.query(
      'INSERT INTO orders(email, products, total, status) VALUES($1, $2, $3, $4) RETURNING *',
      [email, JSON.stringify(items), total, 'paid']
    );

    // Send confirmation email (async)
    sendConfirmationEmail(email, orderRows[0]);

    res.json({ success: true, order: orderRows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Server error processing order" });
  }
});

// ---- Start server ----

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ---- Stripe Webhook ----
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Retrieve items and email from session metadata
    const email = session.customer_email;
    let items = [];
    try {
      if (session.metadata && session.metadata.items) {
        items = JSON.parse(session.metadata.items);
      }
    } catch (e) {
      console.error('Failed to parse items from metadata:', e.message);
    }
    let total = 0;
    for (let item of items) {
      const { rows } = await pool.query('SELECT price, stock FROM products WHERE id=$1', [item.id]);
      if (rows.length === 0) continue;
      total += rows[0].price * item.quantity;
      await pool.query('UPDATE products SET stock = stock - $1 WHERE id=$2', [item.quantity, item.id]);
    }
    await pool.query(
      'INSERT INTO orders(email, products, total, status) VALUES($1, $2, $3, $4)',
      [email, JSON.stringify(items), total, 'paid']
    );
    // Optionally send confirmation email
    // sendConfirmationEmail(email, ...)
  }
  res.json({ received: true });
});

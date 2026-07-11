// Builds the Express app without listening — Supertest (Step 8) imports this
// directly, src/server.js binds it to a port.
const express = require('express');
const healthRouter = require('./routes/health');
const ordersRouter = require('./routes/orders');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');

const app = express();

app.use(express.json());

app.use(healthRouter);
app.use('/order', ordersRouter);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

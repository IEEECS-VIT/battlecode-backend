const express = require('express');
const router = express.Router();
import testRoute from './testRoute.js';

router.use('/test', testRoute);

router.get('/', (req, res) => {
  res.send('API is running');
});



module.exports = router;

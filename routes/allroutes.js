const express = require('express');
const router = express.Router();
const roomRoute = require('./room'); 

router.use('/room', roomRoute);  

router.get('/', (req, res) => {
  res.send('API is running');
});

module.exports = router;

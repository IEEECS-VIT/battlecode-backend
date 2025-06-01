const express = require("express");
const app = express();
const router= require('./routes/allroutes');

app.use(express.urlencoded({ extended: true }));

//route
app.use('/api',router)

app.get("/", (req, res) => {
  res.send("BattleCode Backend");
});

app.listen(5000, () => {
  console.log("Server is running on port 5000");
});
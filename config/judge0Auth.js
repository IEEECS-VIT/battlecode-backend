import axios from "axios";

export const getJudge0Token = async () => {
  const res = await axios.post(
    "https://judge0.com/oauth/token",
    {
      grant_type: "client_credentials",
      client_id: process.env.JUDGE0_CLIENT_ID,
      client_secret: process.env.JUDGE0_CLIENT_SECRET,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  return res.data.access_token;
};

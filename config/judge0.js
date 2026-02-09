import axios from "axios";
import { getJudge0Token } from "./judge0Auth.js";

let cachedToken = null;

const getJudge0Client = async () => {
  if (!cachedToken) {
    cachedToken = await getJudge0Token();
  }

  const baseURL = process.env.JUDGE0_API_URL;

  if (!baseURL) {
    throw new Error("JUDGE0_API_URL is not set");
  }

  console.log("🔍 Judge0 base URL:", baseURL);

  return axios.create({
    baseURL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cachedToken}`,
    },
  });
};

export default getJudge0Client;

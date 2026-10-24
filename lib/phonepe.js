/**
 * PhonePe Payment Gateway Integration (v2 API)
 * Handles OAuth Token, Checkout/Pay, and Status Verification
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '..', '.env');
let lastEnvMtime = 0;

function reloadEnvIfNeeded() {
  try {
    if (fs.existsSync(envPath)) {
      const stats = fs.statSync(envPath);
      if (stats.mtimeMs > lastEnvMtime) {
        lastEnvMtime = stats.mtimeMs;
        const envConfig = dotenv.parse(fs.readFileSync(envPath));
        for (const k in envConfig) {
          process.env[k] = envConfig[k];
        }
      }
    }
  } catch (err) {
    // Ignore read errors
  }
}

let cachedToken = null;
let cachedTokenKey = null;
let tokenExpiresAt = 0;

function getPhonePeConfig() {
  reloadEnvIfNeeded();

  const clientId = (
    process.env.PHONEPE_CLIENT_ID ||
    process.env.PHONEPE_PROD_CLIENT_ID ||
    process.env.PHONEPE_SANDBOX_CLIENT_ID ||
    ""
  ).trim();

  const clientSecret = (
    process.env.PHONEPE_CLIENT_SECRET ||
    process.env.PHONEPE_PROD_CLIENT_SECRET ||
    process.env.PHONEPE_SANDBOX_CLIENT_SECRET ||
    ""
  ).trim();

  const clientVersion = parseInt(
    process.env.PHONEPE_CLIENT_VERSION ||
    process.env.PHONEPE_PROD_CLIENT_VERSION ||
    process.env.PHONEPE_SANDBOX_CLIENT_VERSION ||
    "1",
    10
  );

  const merchantId = (process.env.PHONEPE_MERCHANT_ID || "M23R08DKT83DQ").trim();

  // Determine environment:
  let env = (process.env.PHONEPE_ENV || "").toLowerCase().trim();
  if (env === "sandbox" || env === "uat" || env === "test" || clientId.includes("_") || clientId.toLowerCase().includes("test")) {
    env = "sandbox";
  } else {
    env = "production";
  }
  const isProd = env === "production" || env === "prod";

  const baseUrl = isProd
    ? "https://api.phonepe.com"
    : "https://api-preprod.phonepe.com";

  const tokenUrl = isProd
    ? `${baseUrl}/apis/identity-manager/v1/oauth/token`
    : `${baseUrl}/apis/pg-sandbox/v1/oauth/token`;

  const payUrl = isProd
    ? `${baseUrl}/apis/pg/checkout/v2/pay`
    : `${baseUrl}/apis/pg-sandbox/checkout/v2/pay`;

  const statusUrl = isProd
    ? `${baseUrl}/apis/pg/checkout/v2/order`
    : `${baseUrl}/apis/pg-sandbox/checkout/v2/order`;

  return {
    clientId,
    clientSecret,
    clientVersion,
    env,
    isProd,
    merchantId,
    baseUrl,
    tokenUrl,
    payUrl,
    statusUrl,
  };
}

/**
 * Get or refresh PhonePe OAuth 2.0 access token
 */
async function getPhonePeToken() {
  const config = getPhonePeConfig();

  if (!config.clientId || !config.clientSecret) {
    throw new Error("PhonePe credentials missing: PHONEPE_CLIENT_ID and PHONEPE_CLIENT_SECRET must be defined in the .env file");
  }

  const currentKey = `${config.clientId}_${config.env}`;
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenKey === currentKey && tokenExpiresAt > now + 60) {
    return cachedToken;
  }
  const params = new URLSearchParams({
    client_version: String(config.clientVersion),
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("PhonePe OAuth Error:", response.status, errorText);
    throw new Error(`PhonePe authentication failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  if (!data?.access_token) {
    throw new Error("PhonePe OAuth did not return an access_token");
  }

  cachedToken = data.access_token;
  cachedTokenKey = currentKey;
  tokenExpiresAt = Number(data.expires_at || (now + (Number(data.expires_in) || 3600)));
  return cachedToken;
}

/**
 * Create a PhonePe Checkout V2 Payment session restricted to UPI
 */
async function createPhonePePayment({
  merchantOrderId,
  amountInPaise,
  redirectUrl,
  message = "Lucira Jewelry Order",
  upiOnly = true,
  phoneNumber = null,
}) {
  const token = await getPhonePeToken();
  const config = getPhonePeConfig();

  const enabledPaymentModes = upiOnly
    ? [{ type: "UPI" }]
    : [{ type: "UPI" }, { type: "CARD" }, { type: "NET_BANKING" }];

  let formattedPhone = null;
  if (phoneNumber) {
    const digits = String(phoneNumber).replace(/\D/g, "");
    if (digits.length === 10) {
      formattedPhone = `+91${digits}`;
    } else if (digits.length === 12 && digits.startsWith("91")) {
      formattedPhone = `+${digits}`;
    } else if (digits.length > 10) {
      formattedPhone = `+${digits}`;
    }
  }

  const payload = {
    merchantOrderId,
    amount: amountInPaise,
    expireAfter: 1200,
    paymentFlow: {
      type: "PG_CHECKOUT",
      message,
      merchantUrls: {
        redirectUrl,
      },
      paymentModeConfig: {
        version: "V2",
        enabledPaymentModes,
      },
    },
  };

  if (formattedPhone) {
    payload.prefillUserLoginDetails = {
      phoneNumber: formattedPhone,
    };
  }

  const response = await fetch(config.payUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `O-Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("PhonePe Pay Error:", response.status, data);
    throw new Error(data?.message || data?.error || `PhonePe payment initialization failed (${response.status})`);
  }

  return data;
}

/**
 * Query PhonePe order status by merchantOrderId
 */
async function getPhonePeOrderStatus(merchantOrderId) {
  const token = await getPhonePeToken();
  const config = getPhonePeConfig();

  const url = `${config.statusUrl}/${encodeURIComponent(merchantOrderId)}/status?details=true`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `O-Bearer ${token}`,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("PhonePe Order Status Error:", response.status, data);
    throw new Error(data?.message || data?.error || `Failed to check PhonePe order status (${response.status})`);
  }

  return data;
}

/**
 * Create a PhonePe Payment Link (v1 Paylinks API)
 * https://developer.phonepe.com/payment-gateway/payment-links/api-reference-payment-links/create-payment-link
 */
async function createPhonePePaymentLink({ merchantOrderId, amountInPaise, customer, description = "Lucira Jewelry Order" }) {
  const token = await getPhonePeToken();
  const config = getPhonePeConfig();

  const url = config.isProd
    ? "https://api.phonepe.com/apis/pg/paylinks/v1/pay"
    : "https://api-preprod.phonepe.com/apis/pg-sandbox/paylinks/v1/pay";

  // Phone number normalization (+91 prefix required by PhonePe)
  let phone = customer?.phone || "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) {
    phone = `+91${digits}`;
  } else if (digits.length === 12 && digits.startsWith("91")) {
    phone = `+${digits}`;
  }

  const payload = {
    merchantOrderId,
    description,
    amount: amountInPaise,
    paymentFlow: {
      type: "PAYLINK",
      customerDetails: {
        name: customer?.name || "Lucira Customer",
        phoneNumber: phone || "+919999999999",
        email: customer?.email || "customer@lucirajewelry.com",
      },
      notificationChannels: {
        SMS: false,
        EMAIL: false,
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `O-Bearer ${token}`,
      ...(config.isProd ? { "X-MERCHANT-ID": config.clientId } : {}),
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("PhonePe Paylink Error:", response.status, data);
    throw new Error(data?.message || data?.error || `PhonePe payment link initialization failed (${response.status})`);
  }

  return {
    orderId: data.orderId,
    state: data.state,
    redirectUrl: data.paylinkUrl,
    expireAt: data.expireAt,
    raw: data,
  };
}

/**
 * Query PhonePe Payment Link order status by merchantOrderId
 * https://developer.phonepe.com/payment-gateway/payment-links/api-reference-payment-links/check-payment-link-status
 */
async function getPhonePePaymentLinkStatus(merchantOrderId) {
  const token = await getPhonePeToken();
  const config = getPhonePeConfig();

  const url = config.isProd
    ? `https://api.phonepe.com/apis/pg/paylinks/v1/${encodeURIComponent(merchantOrderId)}/status`
    : `https://api-preprod.phonepe.com/apis/pg-sandbox/paylinks/v1/${encodeURIComponent(merchantOrderId)}/status`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `O-Bearer ${token}`,
      ...(config.isProd ? { "X-MERCHANT-ID": config.clientId } : {}),
    },
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("PhonePe Paylink Status Error:", response.status, data);
    throw new Error(data?.message || data?.error || `Failed to check PhonePe paylink status (${response.status})`);
  }

  return data;
}

module.exports = {
  getPhonePeConfig,
  getPhonePeToken,
  createPhonePePayment,
  getPhonePeOrderStatus,
  createPhonePePaymentLink,
  getPhonePePaymentLinkStatus,
};


const fetch = require('node-fetch');

const STOREFRONT_TOKEN = "2f5e3f91e92ad4d277735b2d63b854bf";
const SHOPIFY_DOMAIN = "luciraonline.myshopify.com";

const query = `
{
  products(first: 10, query: "title:*Gold Coin*") {
    edges {
      node {
        title
        id
        handle
        variants(first: 5) {
          edges {
            node {
              id
              title
              price { amount }
            }
          }
        }
      }
    }
  }
}
`;

async function main() {
  try {
    const response = await fetch(`https://${SHOPIFY_DOMAIN}/api/2024-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": STOREFRONT_TOKEN,
      },
      body: JSON.stringify({ query })
    });
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(err);
  }
}

main();

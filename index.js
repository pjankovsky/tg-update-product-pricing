'use strict';
const QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/810415707352/product_price_asin';

const HOSTNAME = 'mws.amazonservices.com';
const PATH = '/Products/2011-10-01';

const AWS_ACCESS_KEY = 'XXXXXX';
const AWS_SECRET_KEY = 'XXXXXX';
const SELLER_ID = 'XXXXXX';
const MARKETPLACE_ID = 'XXXXXX';

let AWS = require('aws-sdk');
let SQS = new AWS.SQS({apiVersion: '2012-11-05'});
let https = require('https');
let querystring = require('querystring');
let parseString = require('xml2js').parseString;
let amazonSignature = require('tg-node-lib/lib/amazonSignature');
let dbCatalog = require('tg-node-lib/lib/db/catalog');

// vars that need to be reset
let timeout = 0;

exports.handler = (event, context, callback) => {
    timeout = Date.now() + 285000; // 4m45
    // setup returns a promise
    // doing setup each instance might be overkill, but it is better than doing it every time a table is loaded
    dbCatalog.setup()
        .then(() => {
            return poll()
        })
        .then((res) => callback(null, res))
        .catch((err) => callback(err, null));
};

function poll() {
    console.log('-- Poll Queue');
    return new Promise((resolve, reject) => {
        SQS.receiveMessage({
            QueueUrl: QUEUE_URL, // expect queue to have 20 asins per message
            // MaxNumberOfMessages: 1,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1
        }, (err, data) => {
            if (err)
                return reject(err);

            // resolve when no more messages left
            if (typeof data.Messages === 'undefined')
                return resolve('Done');

            // resolve when no more messages left
            if (data.Messages.length < 1)
                return resolve('Done');

            var p = new Promise((resolve) => {
                // do nothing, simply start the chain
                resolve(true);
            });

            for (let i = 0; i < data.Messages.length; i++) {
                p = p.then(() => {
                    return lookupPrice(data.Messages[i].Body);
                });
                p = p.then((result) => {
                    if (result === true)
                        deleteMessage(data.Messages[i]);
                    // return nothing
                })
            }

            p.then(() => {
                // poll again for more messages
                if (Date.now() < timeout) {
                    poll().then((res) => resolve(res)).catch((err) => reject(err));
                } else {
                    resolve('Done');
                }
            }).catch((err) => reject(err));
        })
    });
}

function deleteMessage(Message) {
    console.log('--- Delete Message');
    SQS.deleteMessage({
        QueueUrl: QUEUE_URL,
        ReceiptHandle: Message.ReceiptHandle
    }, (err) => {
        if (err) throw err;
    });
}

function lookupPrice(asinList) {
    let asins = asinList.split(',');
    console.log('--- Price ASINs -> ' + asinList);
    return new Promise((resolve, reject) => {
        // A-Z a-z sort is required for the signature
        let params = {};

        for (var i = 0; i < asins.length; i++) {
            params['ASINList.ASIN.' + (i + 1)] = asins[i];
        }

        params.AWSAccessKeyId = AWS_ACCESS_KEY;
        params.Action = 'GetLowestOfferListingsForASIN';
        params.ExcludeMe = 'true';
        params.ItemCondition = 'New';
        params.MarketplaceId = MARKETPLACE_ID;
        params.SellerId = SELLER_ID;
        params.SignatureMethod = 'HmacSHA256';
        params.SignatureVersion = 2;
        params.Timestamp = amazonSignature.getSigningTimestamp();
        params.Version = '2011-10-01';

        params.Signature = amazonSignature.getSignature('POST', HOSTNAME, PATH, params, AWS_SECRET_KEY);

        var req = https.request({
            hostname: HOSTNAME,
            path: PATH + "?" + querystring.stringify(params),
            method: 'POST'
        }, (req) => {
            let resBody = '';
            req.on('data', (data) => {
                resBody += data;
            });
            req.on('end', () => {
                parseString(resBody, {
                    explicitArray: true // yes super arrays, xml document is way more consistent
                }, (err, result) => {
                    if (err)
                        throw err;
                    resolve(result);
                });
            })
        });

        req.on('error', (err) => reject(err));
        req.end();
    }).then((result) => {
        if (typeof result.GetLowestOfferListingsForASINResponse === 'undefined'
            ||
            typeof result.GetLowestOfferListingsForASINResponse.GetLowestOfferListingsForASINResult === 'undefined'
        ) {
            return false; // something went wrong, keep it in the queue
        }

        var offers = result.GetLowestOfferListingsForASINResponse.GetLowestOfferListingsForASINResult;

        var i, j, p, changes = [],
            asin,
            tmpCost = false,
            productOffers;

        let newCost = false, availability = false;

        for (i = 0; i < offers.length; i++) {
            if (offers[i].$.status != 'Success')
                continue;

            asin = offers[i].$.ASIN;
            availability = false;
            newCost = false;
            tmpCost = false;

            console.log('---- Got Prices -> ' + asin);

            productOffers = offers[i].Product[0].LowestOfferListings[0].LowestOfferListing;

            if (typeof productOffers != 'undefined') {
                for (j = 0; j < productOffers.length; j++) {
                    if (productOffers[j].Qualifiers[0].ItemCondition[0] != 'New')
                        continue;
                    if (productOffers[j].Qualifiers[0].FulfillmentChannel[0] != 'Amazon')
                        continue;
                    if (productOffers[j].Qualifiers[0].ShippingTime[0].Max[0] != '0-2 days')
                        continue;
                    if (productOffers[j].Price[0].Shipping[0].Amount[0] != '0.00')
                        continue;

                    console.log('---- Found Price -> ' + productOffers[j].Price[0].LandedPrice[0].Amount[0]);

                    tmpCost = parseInt(productOffers[j].Price[0].LandedPrice[0].Amount[0].replace('.', '')); // convert to cents
                    if (newCost === false) {
                        newCost = tmpCost;
                    } else {
                        if (tmpCost < newCost)
                            newCost = tmpCost;
                    }
                    availability = true;
                }
            }

            if (newCost === false) {
                newCost = 0;
                availability = false;
            }

            p = dbCatalog.Product()
                .findOne({where: {asin: asin}})
                .then((product) => {
                    if (product === null)
                        throw new Error('Product does not exist. (' + asin + ')');
                    return product.getPrices();
                })
                .then((prices) => {
                    if (prices === null)
                        throw new Error('ProductPrices does not exist. (' + asin + ')');
                    console.log('---- Save Price -> '+ newCost);
                    return prices.updateCost(prices, newCost, availability);
                })
                .then(() => {
                    return true;
                })
                .catch((err) => {
                    console.log(err);
                    return false;
                });
            changes.push(p);
        }

        // promise
        return Promise.all(changes);
    }).then((results) => {
        for (var i = 0; i < results.length; i++) {
            if (results[i] === false)
                return false;
        }
        return true;
    }).catch((err) => {
        console.log(err);
        return false;
    });
}

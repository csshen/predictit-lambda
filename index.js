const axios = require('axios');
const Twit = require('twit');
const cheerio = require('cheerio');
const moment = require('moment');
const math = require('mathjs');
const Nightmare = require('nightmare');
const nightmare = Nightmare({show: false});
const express = require('express');
const app = express();


const { CONSUMER_KEY, CONSUMER_SECRET, ACCESS_TOKEN, ACCESS_TOKEN_SECRET } = process.env;
const T = new Twit({
    consumer_key: CONSUMER_KEY,
    consumer_secret: CONSUMER_SECRET,
    access_token: ACCESS_TOKEN,
    access_token_secret: ACCESS_TOKEN_SECRET
});
const handles = ['realDonaldTrump', 'POTUS', 'VP', 'WhiteHouse'];


app.get('/picount', picount);
app.get('/stats', getStats);
app.listen(process.env.PORT || 3000, () => console.log('All is well'));


function getStats(req, res) {
    let account = req.query.handle || handles[0];
    getDistribution(account)
        .then((stats) => {
            res.send(stats);
        })
        .catch(error => {
            res.send(error)
        });
}

async function getDistribution(account) {
    // helper method for parsing
    function get(handle, min_id, timestamps) {
        return T.get('statuses/user_timeline', { screen_name: handle, max_id: min_id, count: 200 })
            .then((response) => {
                const data = response.data;
                for (let i = 0; i < data.length; i++) {
                    let timestamp = moment(data[i].created_at, 'ddd MMM D HH:mm:ss ZZ YYYY');
                    timestamps.push(timestamp);
                }
                return data.reduce((acc, curr) => Math.min(acc, curr.id), data[0].id);
            })
            .catch((error) => {
                console.log(error)
            });
    }

    // GET ALL TIMESTAMPS
    let timestamps = [];
    let min_id = undefined;

    // This method can only return up to 3,200 of a user's most recent Tweets
    for (let i = 0; i < 10; i++) {
        min_id = await get(account, min_id, timestamps);
    }

    // GROUP TIMESTAMPS BY DAY AND HOUR
    let week = [{}, {}, {}, {}, {}, {}, {}];
    let day = [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}];

    for (let i = 0; i < timestamps.length; i++) {
        let t = timestamps[i];
        let key;

        // GROUP BY DAY
        key = `${t.year()}-${t.week()}`;
        if (week[t.day()][key] == undefined) {
            week[t.day()][key] = 1;
        } else {
            week[t.day()][key] += 1;
        }

        // GROUP BY HOUR
        key = `${t.year()}-${t.week()}-${t.day()}`;
        let h = Math.floor(t.hour() / 2);
        if (day[h][key] == undefined) {
            day[h][key] = 1;
        } else {
            day[h][key] += 1;
        }
    }

    let daily_stats = week.map((obj) => {
        let v = Object.values(obj);
        return {
            sum: math.sum(v),
            mean: math.mean(v),
            std: math.std(v)
        };
    });

    let hourly_stats = day.map((obj) => {
        let v = Object.values(obj);
        return {
            sum: math.sum(v),
            mean: math.mean(v),
            std: math.std(v)
        };
    });

    return {
        account: account,
        day: daily_stats,
        hour: hourly_stats
    };
}

function picount(req, res) {
    return nightmare.goto('http://picount.com/')
        .wait(500)
        .wait('body')
        .evaluate(() => document.querySelector('body').innerHTML)
        .end()
        .then((response) => {
            let $ = cheerio.load(response);

            let data = [];

            $('.module-wrap').each((i, elem) => {
                let prev_counts = $(elem).find('p.counts').text().substring(13).replace(/ /g, '').split(',');
                prev_counts = prev_counts.map(num => parseInt(num))

                data.push({
                    market: $(elem).find('p.market').text(),
                    url: $(elem).find('div.pic-block > a').attr('href'),
                    img: $(elem).find('img.profile-pic').attr('src'),
                    ending: $(elem).find('p.ending').text(),
                    curr_count: parseInt($(elem).find('div.top-right > p').text()),
                    stats: {
                        start: parseInt($($(elem).find('p.stat')[0]).text()),
                        total: parseInt($($(elem).find('p.stat')[1]).text()),
                        avg: $($(elem).find('p.stat')[2]).text(),
                        pace: parseInt($($(elem).find('p.stat')[3]).text()),
                    },
                    prev: {
                        counts: prev_counts,
                        mean: math.mean(prev_counts),
                        std: math.std(prev_counts)
                    }
                });
            });
            res.send(data);
        })
        .catch((error) => {
            res.send(error);
        });
}

/* CODE FOR GETTING COUNTS MANUALLY
function flattenMap(obj) {
    let arr = [];
    for (let prop in obj) {
        let curr = obj[prop];
        curr.screen_name = prop;
        arr.push(curr);
    }
    return arr;
}

function getCounts() {

    T.get('users/lookup', { screen_name: handles })
        .then((response) => {
            let accounts = {};
            let data = response.data;
            for (let i = 0; i < handles.length; i++) {
                accounts['@'+data[i].screen_name] = {
                    curr_count: data[i].statuses_count
                };
            }
            return accounts;
        })
        .then((accounts) => {
            return axios.get('https://www.predictit.org/api/marketdata/all/')
                .then((response) => {
                    let markets = response.data.markets;
                    for (let account in accounts) {
                        let m = markets.find((elem) => {
                            return elem.name.toUpperCase().includes(`How many tweets will ${ account } post from`.toUpperCase());
                        });
                        accounts[account].id = m.id;
                        accounts[account].name = m.name;
                        accounts[account].image = m.image
                        accounts[account].url = m.url;
                        accounts[account].range = [];
                    }

                    // https://github.com/rosshinkley/nightmare-examples/blob/master/docs/common-pitfalls/async-operations-loops.md
                    return flattenMap(accounts).reduce((accumulator, market) => {
                        return accumulator.then(() => {
                            return nightmare.goto(market.url)
                                .wait('body')
                                .evaluate(() => document.querySelector('body').innerHTML)
                                .then((response) => {
                                    let $ = cheerio.load(response);
                                    let rules = $('.market-rules').text();
                                    let startCount = rules.match(/shall exceed(.*?)by/g)[0];
                                    startCount = startCount.slice(13, -3).replace(/,/g, '');
                                    accounts[market.screen_name].start_count = parseInt(startCount);
                                });
                            });
                    }, Promise.resolve()).then(() => {
                        nightmare.end(() => {});
                        return accounts;
                    });
                })
                .catch((error) => {
                    console.log(error);
                });
        })
        .then((accounts) => {
            for (let account in accounts) {
                console.log(account, accounts[account].curr_count - accounts[account].start_count);
            }
        })
        .catch((error) => {
            console.log(error);
        });

}
*/
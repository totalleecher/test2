// Test PG Locatl
const { Client } = require('pg');
const got = require('got');
const Promise = require('bluebird');
const cheerio = require('cheerio');
const HttpAgent = require('agentkeepalive');
const HttpsAgent = require('agentkeepalive').HttpsAgent;
const {CookieJar} = require('tough-cookie');

const keepAliveHttpAgent = new HttpAgent({
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000, // active socket keepalive for 60 seconds
    freeSocketTimeout: 30000, // free socket keepalive for 30 seconds
});
const keepAliveHttpsAgent = new HttpsAgent({
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000, // active socket keepalive for 60 seconds
    freeSocketTimeout: 30000, // free socket keepalive for 30 seconds
});

const cookieJar = new CookieJar();
const SHTBASE = process.env.SHTLINK || "https://www.sehuatang.org/";
const gotInstance = got.extend({
    agent:{
        http: keepAliveHttpAgent,
        https: keepAliveHttpsAgent,
    },
    prefixUrl: SHTBASE,
    cookieJar : cookieJar,
});

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function main(){
    // Init db, 
    try{
        client.connect();
    }catch(err){
        console.error(err);
    }
    console.log("Initializing Database");
    await client.query(`CREATE TABLE IF NOT EXISTS posts(
        id SERIAL PRIMARY KEY,
        url VARCHAR(50) UNIQUE NOT NULL,
        title VARCHAR(100) NOT NULL,
        magnet VARCHAR(100),
        postdate DATE NOT NULL,
        downloaded BOOLEAN
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS downloading(
        id SERIAL PRIMARY KEY,
        url VARCHAR(100) REFERENCES posts(url)
    );`);

    let respone = await gotInstance.get('forum.php?mod=forumdisplay&fid=103&page=1');
    const html = respone.body;
    const $ = cheerio.load(html);
    // console.log($("tbody[id^='normalthread']").length);
    const lastPageHref = $("div.pg > a.last").attr('href');
    response = await gotInstance.get(lastPageHref);
    const regex = /(forum-103-)(\d*).html/;
    const match = lastPageHref.match(regex);
    const forumPrefix = match[1];
    const maxPageNumber = parseInt(match[2]);

    console.log('Checking new posts...');
    const query_text = `INSERT INTO posts (url,title,postdate,downloaded)
    VALUES
        ($1,$2,$3,false)
    ON CONFLICT 
    DO NOTHING;`;
    // let visted = false;
    for (let i = 1 ; i<= 10 ; i++){
        //
        
        const promises = [];
        try{
            respone = await gotInstance.get(`${forumPrefix}${i}.html`);
            const html = respone.body;
            const $ = cheerio.load(html);
            // console.log($("tbody[id^='normalthread'] > tr").length);
            const trs = $("tbody[id^='normalthread'] > tr > th > a.xst");
            trs.each((index,element)=>{
                const href = $(element).attr('href');
                const text = $(element).text();
                const sibling = $(element).parent().next();
                let postDate;
                if ($(sibling).find('em > span > span').attr('title')){
                    postDate = $(sibling).find('em > span > span').attr('title');
                }else{
                    postDate = $(sibling).find('em > span').text();
                }
                // console.log(span);

                promises.push(client.query(query_text,[href,text,new Date(postDate)]));
            });

            await Promise.all(promises);
        }catch(err){
            console.log(err);
        }
    }

    console.log('Fetching magnets from posts...');
    const res = await client.query(`SELECT url FROM posts
    WHERE
    magnet IS NULL
    AND
    downloaded = false;`);

    const postsWithoutMagnet = res.rows;

    const update_query_text = `UPDATE posts
    SET magnet = $1
    WHERE url = $2;`;
    async function parseMagnet(postDoc){
        const url = postDoc['url'];
        respone = await gotInstance.get(url);
        const html = respone.body;
        const $ = cheerio.load(html);

        const magnet = $('div.blockcode > div > ol > li').text();
        if (magnet.includes('magnet')){
            await client.query(update_query_text,[magnet,url]);
        }
    }

    await Promise.map(postsWithoutMagnet,parseMagnet,{concurrency:32});
    console.log('Database Initialization finsihed');
    await client.end();
}

main();
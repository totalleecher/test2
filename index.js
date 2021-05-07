const { Client } = require('pg');
const express = require('express');
const app = express();
const humanInterval = require('human-interval');
const got = require('got');
const Promise = require('bluebird');
const cheerio = require('cheerio');
const HttpAgent = require('agentkeepalive');
const HttpsAgent = require('agentkeepalive').HttpsAgent;
const {CookieJar} = require('tough-cookie');
const http = require('http');
const httpProxy = require('http-proxy');
const request = require('request');
const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const proxy = httpProxy.createProxyServer({
	target: 'ws://localhost:6800',
	ws: true
});
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const ARIA_SECRET = process.env.ARIA2C_SECRET || 'test';
const SHTBASE = process.env.SHTLINK || "https://www.sehuatang.org/";
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

// const axiosInstance = axios.create({httpsAgent: keepAliveHttpsAgent});
const gotInstance = got.extend({
    agent:{
        http: keepAliveHttpAgent,
        https: keepAliveHttpsAgent,
    },
    prefixUrl: SHTBASE,
    cookieJar : cookieJar,
});


// Proxy websocket
server.on('upgrade', (req, socket, head) => {
	proxy.ws(req, socket, head)
});

//Handle normal http traffic
app.use('/jsonrpc', (req, res) => {
	req.pipe(request('http://localhost:6800/jsonrpc')).pipe(res)
});

app.get('/',function(req,res){
    res.send('Hello world!');
})

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));

async function restore_undownloaded(){
    // Get unfinished jobs
    console.log('Restoring unfinished download');
    const query = `SELECT posts.url,title,magnet
    FROM posts
    INNER JOIN downloading
    ON posts.url = downloading.url;`;
    const result = await client.query(query);
    for (const doc of result.rows){
        console.log(doc);
        const url = doc['url'];
        const title = doc['title'];
        const magnet = doc['magnet'];
        const folderNameNoSpace = title.replace(/\s/g,'-');
        //Send to aria2
        const {body} = await got.post("http://localhost:6800/jsonrpc", {
            json: {
                "jsonrpc": "2.0",
                "id": "qwer",
                "method": "aria2.addUri",
                "params": [
                    `token:${ARIA_SECRET}`,
                    [
                        `${magnet}`
                    ],
                    {
                        "dir":`downloads/${folderNameNoSpace}`
                    }
                ]
            },
            responseType: 'json'
        });
        if (body.result){
            const gid = body.result;
            const timer = setInterval(async ()=>{
                const {body} = await got.post("http://localhost:6800/jsonrpc", {
                    json: {
                        "jsonrpc": "2.0",
                        "id": "qwer",
                        "method": "aria2.tellStatus",
                        "params": [
                            `token:${ARIA_SECRET}`,
                            `${gid}`,
                            ["status","followedBy"]
                        ]
                    },
                    responseType: 'json'
                });
                if(body.result && body.result.status && body.result.status == 'complete'){
                        // Metalink downloaded, check followedBy link status
                        if(body.result.followedBy){
                            const followedByGID = (body.result.followedBy)[0];
                            const response = await got.post("http://localhost:6800/jsonrpc", {
                                json: {
                                    "jsonrpc": "2.0",
                                    "id": "qwer",
                                    "method": "aria2.tellStatus",
                                    "params": [
                                        `token:${ARIA_SECRET}`,
                                        `${followedByGID}`,
                                        ["status"]
                                    ]
                                },
                                responseType: 'json'
                            });
                            const jsonres = response.body;
                            if(jsonres.result && jsonres.result.status && jsonres.result.status == 'complete'){
                                console.log(`Complete new item ${url}, ${gid}-> Followed by ${followedByGID}`);                                
                                clearInterval(timer);
                                // Delete such job from downloading
                                const delete_query = `DELETE FROM downloading
                                WHERE url = $1;`;
                                await client.query(delete_query,[url]);
                                // Set download to true
                                const set_to_download_query = `UPDATE posts SET downloaded = true WHERE url = $1`;
                                await client.query(set_to_download_query,[url]);
                            }
                        }
                }                  
            },humanInterval('5 minutes'));
        }
        //Use setInterval to check download status, upon finish, remove table from downloading table, set downloaded to true
    }
}

async function updateDB(){
    let respone = await gotInstance.get('forum.php?mod=forumdisplay&fid=103&page=1');
    const html = respone.body;
    const $ = cheerio.load(html);
    // console.log($("tbody[id^='normalthread']").length);
    const lastPageHref = $("div.pg > a.last").attr('href');
    response = await gotInstance.get(lastPageHref);
    console.log(lastPageHref);
    const regex = /(forum-103-)(\d*).html/;
    const match = lastPageHref.match(regex);
    const forumPrefix = match[1];
    const maxPageNumber = parseInt(match[2]);
    console.log(forumPrefix,maxPageNumber);

    console.log('Checking new posts...');
    const query_text = `INSERT INTO posts (url,title,postdate,downloaded)
    VALUES
        ($1,$2,$3,false)
    ON CONFLICT 
    DO NOTHING;`;

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

    console.log('Fetching magnets from new posts...');
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
}
// 
async function main(){
    await client.connect();
    // Restart undownloaded job
    await restore_undownloaded();
    async function checkNewPost(){
        // Fetch latest post
        await updateDB();
        
        // Get latest date
        const get_date_query = `SELECT postdate FROM posts
        ORDER BY postdate DESC
        LIMIT 1;`;
        let result = await client.query(get_date_query);
        const latestDate = result.rows[0].postdate;
        
        // Query job that is not in downloading table
        const prepare_jobs_query = `SELECT url,magnet,title FROM posts
        WHERE postdate = $1
        AND magnet IS NOT NULL
        AND NOT EXISTS (
            SELECT 1
            FROM downloading
            WHERE posts.url = downloading.url
        )
        AND downloaded = false;`;
        result = await client.query(prepare_jobs_query,[latestDate]);
        // Iterate throuogh rows, add to aria, create a setInterval to check download status
        // After download finished, remove url from downloading table, set downloaded to true
        console.log('Adding magnets...');
        for (const doc of result.rows){
            const url = doc['url'];
            const magnet = doc['magnet'];
            const title = doc['title'];
            const folderNameNoSpace = title.replace(/\s/g,'-');

            const {body} = await got.post("http://localhost:6800/jsonrpc", {
                json: {
                    "jsonrpc": "2.0",
                    "id": "qwer",
                    "method": "aria2.addUri",
                    "params": [
                        `token:${ARIA_SECRET}`,
                        [
                            `${magnet}`
                        ],
                        {
                            "dir":`downloads/${folderNameNoSpace}`
                        }
                    ]
                },
                responseType: 'json'
            });
            if (body.result){
                const gid = body.result;
                // Insert to downloading
                const update_downloading_query = `INSERT INTO downloading (url) VALUES ($1)`;
                await client.query(update_downloading_query,[url]);
                const timer = setInterval(async ()=>{
                    const {body} = await got.post("http://localhost:6800/jsonrpc", {
                        json: {
                            "jsonrpc": "2.0",
                            "id": "qwer",
                            "method": "aria2.tellStatus",
                            "params": [
                                `token:${ARIA_SECRET}`,
                                `${gid}`,
                                ["status","followedBy"]
                            ]
                        },
                        responseType: 'json'
                    });
                    //TODO GID Here is metalink GID, need to check if there is followed by, and is followed_by.status is complete
                    if(body.result && body.result.status && body.result.status == 'complete'){
                        // Metalink downloaded, check followedBy link status
                        if(body.result.followedBy){
                            const followedByGID = (body.result.followedBy)[0];
                            const response = await got.post("http://localhost:6800/jsonrpc", {
                                json: {
                                    "jsonrpc": "2.0",
                                    "id": "qwer",
                                    "method": "aria2.tellStatus",
                                    "params": [
                                        `token:${ARIA_SECRET}`,
                                        `${followedByGID}`,
                                        ["status"]
                                    ]
                                },
                                responseType: 'json'
                            });
                            const jsonres = response.body;
                            if(jsonres.result && jsonres.result.status && jsonres.result.status == 'complete'){
                                console.log(`Complete new item ${url}, ${gid}-> Followed by ${followedByGID}`);                                
                                clearInterval(timer);
                                // Delete such job from downloading
                                const delete_query = `DELETE FROM downloading
                                WHERE url = $1;`;
                                await client.query(delete_query,[url]);
                                // Set download to true
                                const set_to_download_query = `UPDATE posts SET downloaded = true WHERE url = $1`;
                                await client.query(set_to_download_query,[url]);
                            }
                        }
                    }                  
                },humanInterval('5 minutes'));
            }
        }
        setTimeout(checkNewPost,humanInterval('1 hour'));
    }
    await checkNewPost();
}

main().catch((err)=>{
    console.log(err);
    client.end().then(()=>{
        process.exit(1);
    })
});

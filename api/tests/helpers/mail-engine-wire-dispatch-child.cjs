'use strict';
// Disposable integration child: intentionally killed after the peer applies MOVE, before ACK.
const mysql = require('mysql2/promise');
const imaps = require('imap-simple');
const { guardImapConnection } = require('../../src/services/mail-imap-guard');
const { selectMailbox } = require('../../src/services/mail-engine/transport');

process.once('message', async ({ op, job, port }) => {
  const pool = mysql.createPool({ host:process.env.MYSQL_TEST_HOST,port:Number(process.env.MYSQL_TEST_PORT || 3306),
    user:process.env.MYSQL_TEST_USER,password:process.env.MYSQL_TEST_PASSWORD,
    database:process.env.MYSQL_TEST_DATABASE,timezone:'+00:00',connectionLimit:3 });
  require('../../src/state').setDb(pool);
  let connection;
  try {
    connection = guardImapConnection(await imaps.connect({ imap:{host:'127.0.0.1',port,
      user:'fixture',password:'fixture',tls:false,keepalive:false,connTimeout:1000,authTimeout:1000,socketTimeout:1000} }),
    { timeoutMs:3000 });
    connection.on('error', () => {});
    await selectMailbox(connection,{folder:'INBOX'});
    await require('../../src/services/mail-engine/operations').applyMove(op,connection,Number(job.worker_generation),
      new AbortController().signal,job.lease_owner,job.id);
    process.send?.({ unexpectedCompletion:true });
  } catch (error) {
    process.send?.({ errorCode:error.code || 'UNEXPECTED_CHILD_FAILURE' });
  } finally {
    connection?.end(); await pool.end();
  }
});

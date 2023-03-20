// Copyright Epic Games, Inc. All Rights Reserved.
var enableRedirectionLinks = true;
var enableRESTAPI = true;

const defaultConfig = {
	// The port clients connect to the matchmaking service over HTTP
	// 用户通过HTTP连接配对服务器的端口
	HttpPort: 90,
	UseHTTPS: false,
	// The matchmaking port the signaling service connects to the matchmaker
	// 信令服务器连接配对服务器的端口
	MatchmakerPort: 9999,

	// Log to file
	// 写日志
	LogToFile: true
};

// Similar to the Signaling Server (SS) code, load in a config.json file for the MM parameters

// 通过 require('yargs') 模块获取控制台参数
const argv = require('yargs').argv;

// var：关键字，声明变量。
// argv.configFile指通过控制台传输的名为configFile的参数。
// 传参方法：node yourscript.js --configFile yourvalue

// 如果参数为空，使用config.json文件作为配置文件
var configFile = (typeof argv.configFile != 'undefined') ? argv.configFile.toString() : '.\\config.json';
// console.log函数：用于在控制台上显示内容
console.log(`configFile ${configFile}`);
// require：引入模块，后续调用其中的init函数进行初始化配置
// 把默认配置写入配置文件
const config = require('./modules/config.js').init(configFile, defaultConfig);
// JSON.stringify：将配置对象转换为字符串，以便在控制台上显示
console.log("Config: " + JSON.stringify(config, null, '\t'));

// 引入模块，共同创建一个基于expresss、支持CORS（跨域资源共享）的HTTP服务器
// 跨域资源共享允许来自一个域名的资源被另一个域名请求
// 包括Node.js内置模块。Node.js是开源、跨平台的JavaScript运行时环境
const express = require('express');
var cors = require('cors');
const app = express();
const http = require('http').Server(app);
const fs = require('fs');
const path = require('path');
const logging = require('./modules/logging.js');
// 注册一个控制台日志记录器，它会将日志信息输出到控制台
logging.RegisterConsoleLogger();

if (config.LogToFile) {
	// 注册一个文件日志记录器，将日志信息写入指定的文件中
	logging.RegisterFileLogger('./logs');
}

// A list of all the Cirrus server which are connected to the Matchmaker.
// map存储键值对，按原始插入（set）顺序存储。set(key,value)
var cirrusServers = new Map();

//
// Parse command line.
//

if (typeof argv.HttpPort != 'undefined') {
	config.HttpPort = argv.HttpPort;
}
if (typeof argv.MatchmakerPort != 'undefined') {
	config.MatchmakerPort = argv.MatchmakerPort;
}

// 导入python-shell模块
const {PythonShell} = require('python-shell');

// 启动 HTTP 服务器并监听指定端口.可以在这里调用python脚本
http.listen(config.HttpPort, () => {
    console.log('HTTP listening on *:' + config.HttpPort);
	 // 调用Python脚本，传递config.HttpPort作为参数
	 let options = {
		mode: 'text',
		pythonPath:'C:\\Users\\fansi\\AppData\\Local\\Programs\\Python\\Python39\\python.exe',
		scriptPath:'E:\\pythonProject\\',
		args: [config.HttpPort]
	  };
	  PythonShell.run('HttpPort_connect.py', options, function (err, results) {
		if (err) throw err;
		// 打印Python脚本的输出结果
		console.log('results: %j', results);
	  });
});


if (config.UseHTTPS) {
	//HTTPS certificate details
	const options = {
		key: fs.readFileSync(path.join(__dirname, './certificates/client-key.pem')),
		cert: fs.readFileSync(path.join(__dirname, './certificates/client-cert.pem'))
	};

	var https = require('https').Server(options, app);

	//Setup http -> https redirect
	console.log('Redirecting http->https');
	app.use(function (req, res, next) {
		if (!req.secure) {
			if (req.get('Host')) {
				var hostAddressParts = req.get('Host').split(':');
				var hostAddress = hostAddressParts[0];
				if (httpsPort != 443) {
					hostAddress = `${hostAddress}:${httpsPort}`;
				}
				return res.redirect(['https://', hostAddress, req.originalUrl].join(''));
			} else {
				console.error(`unable to get host name from header. Requestor ${req.ip}, url path: '${req.originalUrl}', available headers ${JSON.stringify(req.headers)}`);
				return res.status(400).send('Bad Request');
			}
		}
		next();
	});

	https.listen(443, function () {
		console.log('Https listening on 443');
	});
}

// No servers are available so send some simple JavaScript to the client to make
// it retry after a short period of time.
// 在所有 Cirrus 服务器都被占用时，向客户端发送一个提示信息，并在倒计时结束后自动刷新页面。
function sendRetryResponse(res) {
	// res.send方法发送HTML代码，其中包含一段JavaScript代码
	// 使用 setInterval() 函数每隔 1 秒钟执行一次回调函数
	res.send(`All ${cirrusServers.size} Cirrus servers are in use. Retrying in <span id="countdown">10</span> seconds.
	<script>
		var countdown = document.getElementById("countdown").textContent;
		setInterval(function() {
			countdown--;
			if (countdown == 0) {
				window.location.reload(1);
			} else {
				document.getElementById("countdown").textContent = countdown;
			}
		}, 1000);
	</script>`);
}

// Get a Cirrus server if there is one available which has no clients connected.
function getAvailableCirrusServer() {
	for (cirrusServer of cirrusServers.values()) {
		// 如果一个 Cirrus 服务器满足以下条件，则认为它是可用的：
		// 它当前没有连接的客户端（numConnectedClients === 0）
		// 它处于就绪状态（ready === true）
		// 距离上次重定向至少过去了 45 秒（为了避免在用户点击play前，使两个用户使用同一个信令服务器）
		// 为什么？点击play会改变信令服务器的什么状态？
		if (cirrusServer.numConnectedClients === 0 && cirrusServer.ready === true) {

			// Check if we had at least 45 seconds since the last redirect, avoiding the 
			// chance of redirecting 2+ users to the same SS before they click Play.
			if( cirrusServer.lastRedirect ) {
				if( ((Date.now() - cirrusServer.lastRedirect) / 1000) < 45 )
					continue;
			}
			cirrusServer.lastRedirect = Date.now();

			return cirrusServer;
		}
	}
	// 如果没找到可用的Cirrus服务器就输出警告信息
	// cirrus服务器和信令服务器？相同吗？
	console.log('WARNING: No empty Cirrus servers are available');
	return undefined;
}

// 遵循REST（Representational State Transfer）架构风格的API请求
// REST API使用HTTP协议来传输数据
// 果 enableRESTAPI 为真，
// 代码会在/signallingserver 端点上设置一个接受 GET 和 OPTIONS 请求的路由
// 当向此端点发送 GET 请求时，服务器会以JSON对象的形式响应一个可用信令服务器的地址和端口
if(enableRESTAPI) {
	// Handle REST signalling server only request.
	app.options('/signallingserver', cors())
	app.get('/signallingserver', cors(),  (req, res) => {
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			res.json({ signallingServer: `${cirrusServer.address}:${cirrusServer.port}`});
			console.log(`Returning ${cirrusServer.address}:${cirrusServer.port}`);
		} else {
			res.json({ signallingServer: '', error: 'No signalling servers available'});
		}
	});
}

// 处理HTTP GET请求
// 来自客户端的请求
if(enableRedirectionLinks) {
	// Handle standard URL.
	app.get('/', (req, res) => {
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			res.redirect(`http://${cirrusServer.address}:${cirrusServer.port}/`);
			//console.log(req);
			console.log(`Redirect to ${cirrusServer.address}:${cirrusServer.port}`);
		} else {
			sendRetryResponse(res);
		}
	});

	// Handle URL with custom HTML.
	app.get('/custom_html/:htmlFilename', (req, res) => {
		cirrusServer = getAvailableCirrusServer();
		if (cirrusServer != undefined) {
			res.redirect(`http://${cirrusServer.address}:${cirrusServer.port}/custom_html/${req.params.htmlFilename}`);
			console.log(`Redirect to ${cirrusServer.address}:${cirrusServer.port}`);
		} else {
			sendRetryResponse(res);
		}
	});
}

//
// Connection to Cirrus.
//

const net = require('net');

function disconnect(connection) {
	console.log(`Ending connection to remote address ${connection.remoteAddress}`);
	connection.end();
}

// net.createServer() 方法用于创建一个新的TCP服务器，
// 它接受一个回调函数作为参数，该回调函数在每次有新的客户端连接到服务器时被调用。

const matchmaker = net.createServer((connection) => {
	// 当有新的客户端连接到服务器时，会为该连接注册一个 data 事件处理程序
	connection.on('data', (data) => {
		// 当客户端发送数据到服务器时，此事件处理程序会被调用，
		// 并尝试将接收到的数据解析为JSON对象，如果解析成功，则打印消息类型
		try {
			message = JSON.parse(data);

			if(message)
				console.log(`Message TYPE: ${message.type}`);
		} catch(e) {
			console.log(`ERROR (${e.toString()}): Failed to parse Cirrus information from data: ${data.toString()}`);
			disconnect(connection);
			return;
		}
		if (message.type === 'connect') {
			// A Cirrus server connects to this Matchmaker server.
			// 创建连接上Matchmaker的Cirrus Server对象
			cirrusServer = {
				address: message.address,
				port: message.port,
				numConnectedClients: 0,
				lastPingReceived: Date.now()
			};
			cirrusServer.ready = message.ready === true;

			// Handles disconnects between MM and SS to not add dupes with numConnectedClients = 0 and redirect users to same SS
			// Check if player is connected and doing a reconnect. message.playerConnected is a new variable sent from the SS to
			// help track whether or not a player is already connected when a 'connect' message is sent (i.e., reconnect).
			if(message.playerConnected == true) {
				cirrusServer.numConnectedClients = 1;
			}

			// Find if we already have a ciruss server address connected to (possibly a reconnect happening)
			let server = [...cirrusServers.entries()].find(([key, val]) => val.address === cirrusServer.address && val.port === cirrusServer.port);

			// if a duplicate server with the same address isn't found -- add it to the map as an available server to send users to.
			if (!server || server.size <= 0) {
				console.log(`Adding connection for ${cirrusServer.address.split(".")[0]} with playerConnected: ${message.playerConnected}`)
				cirrusServers.set(connection, cirrusServer);
            } else {
				console.log(`RECONNECT: cirrus server address ${cirrusServer.address.split(".")[0]} already found--replacing. playerConnected: ${message.playerConnected}`)
				var foundServer = cirrusServers.get(server[0]);
				
				// Make sure to retain the numConnectedClients from the last one before the reconnect to MM
				if (foundServer) {					
					cirrusServers.set(connection, cirrusServer);
					console.log(`Replacing server with original with numConn: ${cirrusServer.numConnectedClients}`);
					cirrusServers.delete(server[0]);
				} else {
					cirrusServers.set(connection, cirrusServer);
					console.log("Connection not found in Map() -- adding a new one");
				}
			}
		} else if (message.type === 'streamerConnected') {
			// The stream connects to a Cirrus server and so is ready to be used
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.ready = true;
				console.log(`Cirrus server ${cirrusServer.address}:${cirrusServer.port} ready for use`);
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'streamerDisconnected') {
			// The stream connects to a Cirrus server and so is ready to be used
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.ready = false;
				console.log(`Cirrus server ${cirrusServer.address}:${cirrusServer.port} no longer ready for use`);
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'clientConnected') {
			// A client connects to a Cirrus server.
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.numConnectedClients++;
				console.log(`Client connected to Cirrus server ${cirrusServer.address}:${cirrusServer.port}`);
			} else {
				disconnect(connection);
			}
		} else if (message.type === 'clientDisconnected') {
			// A client disconnects from a Cirrus server.
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.numConnectedClients--;
				console.log(`Client disconnected from Cirrus server ${cirrusServer.address}:${cirrusServer.port}`);
			} else {				
				disconnect(connection);
			}
		} else if (message.type === 'ping') {
			cirrusServer = cirrusServers.get(connection);
			if(cirrusServer) {
				cirrusServer.lastPingReceived = Date.now();
			} else {				
				disconnect(connection);
			}
		} else {
			console.log('ERROR: Unknown data: ' + JSON.stringify(message));
			disconnect(connection);
		}
	});

	// A Cirrus server disconnects from this Matchmaker server.
	connection.on('error', () => {
		cirrusServer = cirrusServers.get(connection);
		if(cirrusServer) {
			cirrusServers.delete(connection);
			console.log(`Cirrus server ${cirrusServer.address}:${cirrusServer.port} disconnected from Matchmaker`);
		} else {
			console.log(`Disconnected machine that wasn't a registered cirrus server, remote address: ${connection.remoteAddress}`);
		}
	});
});

matchmaker.listen(config.MatchmakerPort, () => {
	console.log('Matchmaker listening on *:' + config.MatchmakerPort);
});

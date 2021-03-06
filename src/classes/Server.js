import Koa from "koa";
import fs from "fs";
import compress from "koa-compress";
import conditional from "koa-conditional-get";
import cors from "kcors";
import bodyParser from "koa-bodyparser";
import session from "koa-session";
import etags from "koa-etag";
import helmet from "koa-helmet";
import json from "koa-json";
import koaConvert from "koa-convert";
import send from "koa-send";
import logger from "koa-logger";
import path from "path";
import webpack from "webpack";
import Ddos from "ddos";
import passport from "koa-passport";

import Router from "./Router";
import Webpack from "./Webpack";
import PassportHandler from "./PassportHandler";

//
//Handle main Koa2 and webpack for app.
//
export default class Server {
  constructor(props, parent) {
    this.parent = parent;
    this.logger = parent.logger;
    this.app = new Koa();
    this.listen = null;
    this.router = new Router({}, this);
    this.passport = new PassportHandler({}, this);

    this.isRunning = false;
    this.isDevMode =
      this.parent.config.environment == "development" ? true : false;
  }

  async renderReactApps() {
    if (this.isDevMode) {
      return new Promise(async (resolve, reject) => {
        const webpackDevMiddleware = require("webpack-dev-middleware");
        const webpackHotMiddleware = require("koa-webpack-hot-middleware");
        const webpackHotServerMiddleware = require("webpack-hot-server-middleware");

        let routes = await this.router.ReactRoutes.map(
          routeObject =>
            new Promise(async (resolve, reject) => {
              const compiledConfigs = await routeObject.webpack.compile(() => {
                resolve("compile complete");
              });

              await this.app.use(
                this.koaDevware(
                  webpackDevMiddleware(compiledConfigs, {
                    serverSideRender: true,
                    publicPath:
                      compiledConfigs.compilers[0].options.output.publicPath,
                    stats: {
                      colors: true,
                      modules: false
                    }
                  })
                )
              );

              await this.app.use(
                koaConvert(webpackHotMiddleware(compiledConfigs.compilers[0]))
              );

              await this.app.use(
                webpackHotServerMiddleware(compiledConfigs, {
                  createHandler: webpackHotServerMiddleware.createKoaHandler,
                  serverRendererOptions: {
                    passport: passport,
                    authMiddleware: routeObject.authMiddleware,
                    middleware: routeObject.middleware
                  }
                })
              );
            })
        );
        await Promise.all(routes);
        resolve();
      });
    } else {
      return new Promise(async (resolve, reject) => {
        this.parent.logger.info(
          "[VelopServer][Compile] Getting files ready, this may take a while...."
        );

        //Render React Routes
        let routes = await this.router.ReactRoutes.map(
          routeObject =>
            new Promise((resolve, reject) => {
              const { clientConfig, serverConfig } = routeObject.webpack;
              const { authMiddleware } = routeObject;

              routeObject.webpack.compileWithCallback((err, stats) => {
                //host static files and files only
                stats.toJson().children[0].assets.map(asset => {
                  const publicPath = path.posix.join(
                    clientConfig.output.publicPath,
                    asset.name
                  );

                  this.app.use(async (ctx, next) => {
                    if (ctx.path == publicPath) {
                      await send(ctx, asset.name, {
                        root: clientConfig.output.path
                      });
                    } else {
                      return next();
                    }
                  });
                });

                //render html if route matches..
                let clientStats = stats.toJson().children[0];
                let serverStats = stats.toJson().children[1];

                let serverRender;
                let serverFile;
                let staticFiles = [];
                serverStats.assets.map(file => {
                  if (path.extname(file.name) == ".js") {
                    serverRender = require(path.resolve(
                      serverConfig.output.path,
                      file.name
                    ));
                  } else {
                    let staticFilePath = path.resolve(
                      serverConfig.output.path,
                      file.name
                    );
                    this.router.addStaticFile(staticFilePath);
                    staticFiles.push(file.name);
                  }
                });

                this.app.use(
                  serverRender({
                    clientStats,
                    authMiddleware,
                    passport,
                    staticFiles
                  })
                );

                resolve();
              });
            })
        );
        await Promise.all(routes);
        resolve();
      });
    }
  }

  /**
   * Start server
   * @return {[type]} [description]
   */
  async start() {
    try {
      if (this.isDevMode)
        this.parent.logger.info(
          "[VelopServer][Start] Running in development mode!"
        );
      else
        this.parent.logger.info(
          "[VelopServer][Start] Running in production mode!"
        );

      if (
        this.parent.config.environment == "development" &&
        this.parent.config.options &&
        this.parent.config.options.logRequests
      )
        this.app.use(logger());

      await this.addKoaMiddleware();
      this.passport.initStrategies();

      if (this.router.ReactRoutes.length > 0) await this.renderReactApps();
      this.router.setupStaticRoutes();

      return this.startListen();
    } catch (e) {
      this.parent.logger.error("[VelopServer] Server start(): " + e);
    }
  }

  /**
   * Start listening
   */
  startListen() {
    this.parent.logger.info(
      "[VelopServer] Starting server on http://%s:%s",
      this.parent.config.hostname,
      this.parent.config.port
    );

    //add routes
    this.app.use(this.router.api.routes());
    this.app.use(this.router.api.allowedMethods());

    //Only start once
    if (!this.isRunning) {
      this.isRunning = !this.isRunning;
      this.listen = this.app.listen(this.parent.config.port, () => {
        this.parent.logger.info();
        this.parent.logger.info(
          "[VelopServer] ==> Server is up at http://%s:%s <===",
          this.parent.config.hostname,
          this.parent.config.port
        );
        this.parent.logger.info();
      });

      return this.listen;
    } else {
      return false;
    }
  }

  async stop() {
    this.parent.logger.info("[VelopServer] - Stop server");
    this.listen.close();
  }
  /**
   * Handle Koa Development middleware after compile is complete
   * @param  {webpackmiddleware} dev
   * @param  {webpackcompiler} compiler
   * @return {function} Function to be called
   */
  koaDevware(dev, compiler) {
    const waitMiddleware = () =>
      new Promise((resolve, reject) => {
        dev.waitUntilValid(() => resolve(true));
        compiler.plugin("failed", error => reject(error));
      });

    return async (ctx, next) => {
      await waitMiddleware();
      await dev(
        ctx.req,
        {
          end(content) {
            ctx.body = content;
          },
          setHeader: ctx.set.bind(ctx),
          locals: ctx.state
        },
        next
      );
    };
  }

  async addKoaMiddleware() {
    // if (this.parent.config.options && this.parent.config.options.useDdos){
    //   let ddos = new Ddos(this.parent.config.options.ddosOptions)
    //   this.app.use(ddos.koa().bind(ddos))
    // }

    if (this.parent.config.options && this.parent.config.options.useHelmet)
      this.app.use(helmet(this.parent.config.options.helmetOptions));

    if (this.parent.config.options && this.parent.config.options.useJsonPretty)
      this.app.use(json());

    if (this.parent.config.options && this.parent.config.options.useCompress)
      this.app.use(compress(this.parent.config.options.compressOptions));

    if (this.parent.config.options && this.parent.config.options.useCors)
      this.app.use(cors(this.parent.config.options.corsOptions));

    if (this.parent.config.options && this.parent.config.options.useEtags) {
      this.app.use(conditional());
      this.app.use(etags());
    }

    if (this.parent.config.options.session.use == true) {
      if (this.parent.config.options.session.key == "secret")
        this.parent.logger.warn(
          "[VelopServer][Session] - YOU HAVE NOT SET A SESSION KEY, THIS CAN BE A SECURITY RISK"
        );

      this.app.keys = [this.parent.config.options.session.key];
      this.app.use(session({}, this.app));
    }

    this.app.use(bodyParser());
  }
}

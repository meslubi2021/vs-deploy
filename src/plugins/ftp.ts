/// <reference types="node" />

// The MIT License (MIT)
// 
// vs-deploy (https://github.com/mkloubert/vs-deploy)
// Copyright (c) Marcel Joachim Kloubert <marcel.kloubert@gmx.net>
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// 
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

import * as deploy_contracts from '../contracts';
import * as deploy_helpers from '../helpers';
import * as deploy_objects from '../objects';
import * as FS from 'fs';
import * as FTP from 'ftp';
import * as i18 from '../i18';
const jsFTP = require('jsftp');
import * as Path from 'path';
import * as TMP from 'tmp';
import * as vscode from 'vscode';


interface DeployTargetFTP extends deploy_contracts.DeployTarget {
    dir?: string;
    host?: string;
    port?: number;
    rejectUnauthorized?: boolean;
    user?: string;
    password?: string;
    secure?: boolean;
    connTimeout?: number;
    pasvTimeout?: number;
    keepalive?: number;
    engine?: string;
}

interface FTPContext {
    cachedRemoteDirectories: any;
    connection: FtpClientBase;
    hasCancelled: boolean;
}

function getDirFromTarget(target: DeployTargetFTP): string {
    let dir = deploy_helpers.toStringSafe(target.dir);
    if (!dir) {
        dir = '/';
    }

    return dir;
}

function toFTPPath(path: string): string {
    return deploy_helpers.replaceAllStrings(path, Path.sep, '/');
}

abstract class FtpClientBase {
    public abstract connect(target: DeployTargetFTP): Promise<boolean>;

    public abstract cwd(dir: string): Promise<string>;

    public abstract end(): Promise<boolean>;

    public abstract get(file: string): Promise<Buffer>;

    public abstract mkdir(dir: string): Promise<string>;

    public abstract put(file: string, data: Buffer): Promise<Buffer>;
}

class FtpClient extends FtpClientBase {
    protected _connection: FTP;

    public connect(target: DeployTargetFTP): Promise<boolean> {
        let me = this;

        let isSecure = deploy_helpers.toBooleanSafe(target.secure, false);

        let host = deploy_helpers.toStringSafe(target.host, deploy_contracts.DEFAULT_HOST);
        let port = parseInt(deploy_helpers.toStringSafe(target.port, isSecure ? '990' : '21').trim());

        let user = deploy_helpers.toStringSafe(target.user, 'anonymous');
        let pwd = deploy_helpers.toStringSafe(target.password);

        let rejectUnauthorized = target.rejectUnauthorized;
        if (deploy_helpers.isNullOrUndefined(rejectUnauthorized)) {
            rejectUnauthorized = true;
        }
        rejectUnauthorized = !!rejectUnauthorized;

        let connTimeout = parseInt(deploy_helpers.toStringSafe(target.connTimeout).trim());
        if (isNaN(connTimeout)) {
            connTimeout = undefined;
        }

        let pasvTimeout = parseInt(deploy_helpers.toStringSafe(target.pasvTimeout).trim());
        if (isNaN(pasvTimeout)) {
            pasvTimeout = undefined;
        }

        let keepalive = parseInt(deploy_helpers.toStringSafe(target.keepalive).trim());
        if (isNaN(keepalive)) {
            keepalive = undefined;
        }
        
        return new Promise<boolean>((resolve, reject) => {
            let conn: FTP;
            let completedInvoked = false;
            let completed = (err: any, connected?: boolean) => {
                if (completedInvoked) {
                    return;
                }
                
                completedInvoked = true;
                if (err) {
                    reject(err);
                }
                else {
                    me._connection = conn;

                    resolve(connected);
                }
            };

            try {
                if (me.connection) {
                    completed(null, false);
                    return;
                }

                conn = new FTP();
                conn.once('error', function(err) {
                    if (err) {
                        completed(err);
                    }
                    else {
                        completed(null, true);
                    }
                });
                conn.once('ready', function() {
                    completed(null, true);
                });
                conn.connect({
                    host: host, port: port,
                    user: user, password: pwd,
                    secure: isSecure,
                    secureOptions: {
                        rejectUnauthorized: rejectUnauthorized,
                    },
                    connTimeout: connTimeout,
                    pasvTimeout: pasvTimeout,
                    keepalive: keepalive,
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public get connection(): FTP {
        return this._connection;
    }

    public cwd(dir: string): Promise<string> {
        let me = this;

        return new Promise<string>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<string>(resolve, reject);

            try {
                me.connection.cwd(dir, (err) => {
                    if (err) {
                        completed(err);
                    }
                    else {
                        completed(null, dir);
                    }
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public end(): Promise<boolean> {
        let me = this;

        return new Promise<boolean>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<boolean>(resolve, reject);

            try {
                let conn = this._connection;

                if (conn) {
                    conn.end();

                    me._connection = null;
                    completed(null, true);
                }
                else {
                    completed(null, false);
                }
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public get(file: string): Promise<Buffer> {
        let me = this;

        return new Promise<Buffer>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<Buffer>(resolve, reject);

            try {
                me.connection.get(file, (err, stream) => {
                    if (err) {
                        completed(err);
                    }
                    else {
                        try {
                            TMP.tmpName({
                                keep: true,
                            }, (err, tmpFile) => {
                                let deleteTempFile = (err: any, data?: Buffer) => {
                                    // delete temp file ...
                                    FS.exists(tmpFile, (exists) => {
                                        if (exists) {
                                            // ... if exist

                                            FS.unlink(tmpFile, () => {
                                                completed(err, data);
                                            });
                                        }
                                        else {
                                            completed(err, data);
                                        }
                                    });
                                };

                                let downloadCompleted = (err: any) => {
                                    if (err) {
                                        deleteTempFile(err);
                                    }
                                    else {
                                        FS.readFile(tmpFile, (err, data) => {
                                            if (err) {
                                                deleteTempFile(err);
                                            }
                                            else {
                                                deleteTempFile(null, data);
                                            }
                                        });
                                    }
                                };

                                try {
                                    // copy to temp file
                                    stream.pipe(FS.createWriteStream(tmpFile));

                                    stream.once('end', () => {
                                        downloadCompleted(null);
                                    });
                                }
                                catch (e) {
                                    downloadCompleted(e);
                                }
                            });
                        }
                        catch (e) {
                            completed(e);
                        }
                    }
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public mkdir(dir: string): Promise<string> {
        let me = this;

        return new Promise<string>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<string>(resolve, reject);

            try {
                me.connection.mkdir(dir, true, (err) => {
                    if (err) {
                        completed(err);
                    }
                    else {
                        completed(null, dir);
                    }
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public put(file: string, data: Buffer): Promise<Buffer> {
        let me = this;

        if (!data) {
            data = Buffer.alloc(0);
        }

        return new Promise<Buffer>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<Buffer>(resolve, reject);

            try {
                me.connection.put(data, file, (err) => {
                    if (err) {
                        completed(err);
                    }
                    else {
                        completed(null, data);
                    }
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }
}

class JsFTPClient extends FtpClientBase {
    protected _connection: any;

    public connect(target: DeployTargetFTP): Promise<boolean> {
        let me = this;

        let isSecure = deploy_helpers.toBooleanSafe(target.secure, false);

        let host = deploy_helpers.toStringSafe(target.host, deploy_contracts.DEFAULT_HOST);
        let port = parseInt(deploy_helpers.toStringSafe(target.port, isSecure ? '990' : '21').trim());

        let user = deploy_helpers.toStringSafe(target.user, 'anonymous');
        let pwd = deploy_helpers.toStringSafe(target.password);
        
        return new Promise<boolean>((resolve, reject) => {
            let conn: any;
            let completedInvoked = false;
            let completed = (err: any, connected?: boolean) => {
                if (completedInvoked) {
                    return;
                }
                
                completedInvoked = true;
                if (err) {
                    reject(err);
                }
                else {
                    me._connection = conn;

                    resolve(connected);
                }
            };

            try {
                if (me.connection) {
                    completed(null, false);
                    return;
                }

                conn = new jsFTP({
                    host: host,
                    port: port,
                    user: user, 
                    pass: pwd,
                });
                
                me._connection = conn;

                completed(null, true);
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public get connection(): any {
        return this._connection;
    }

    public cwd(dir: string): Promise<string> {
        let me = this;

        return new Promise<string>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<string>(resolve, reject);

            try {
                me.connection.list(dir, (err) => {
                    if (err) {
                        completed(err);
                    }
                    else {
                        completed(null, dir);
                    }
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public end(): Promise<boolean> {
        let me = this;

        return new Promise<boolean>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<boolean>(resolve, reject);

            try {
                let conn = this._connection;

                if (conn) {
                    conn.destroy();

                    me._connection = null;
                    completed(null, true);
                }
                else {
                    completed(null, false);
                }
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public get(file: string): Promise<Buffer> {
        let me = this;

        return new Promise<Buffer>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<Buffer>(resolve, reject);

            try {
                me.connection.get(file, (err, socket) => {
                    if (err) {
                        completed(err);
                    }
                    else {
                        try {
                            let result: Buffer = Buffer.alloc(0);

                            socket.on("data", function(data: Buffer) {
                                try {
                                    if (data) {
                                        result = Buffer.concat([result, data]);
                                    }
                                }
                                catch (e) {
                                    completed(e);
                                }
                            });

                            socket.once("close", function(hadErr) {
                                if (hadErr) {
                                    completed(hadErr);
                                }
                                else {
                                    completed(null, result);
                                }
                            });

                            socket.resume();
                        }
                        catch (e) {
                            completed(e);
                        }
                    }
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public mkdir(dir: string): Promise<string> {
        let me = this;

        return new Promise<string>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<string>(resolve, reject);

            try {
                me.connection.raw.mkd(dir, (err) => {
                    if (err) {
                        completed(err);
                    }
                    else {
                        completed(null, dir);
                    }
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }

    public put(file: string, data: Buffer): Promise<Buffer> {
        let me = this;

        if (!data) {
            data = Buffer.alloc(0);
        }

        return new Promise<Buffer>((resolve, reject) => {
            let completed = deploy_helpers.createSimplePromiseCompletedAction<Buffer>(resolve, reject);

            try {
                me.connection.put(data, file, (err) => {
                    if (err) {
                        completed(err);
                    }
                    else {
                        completed(null, data);
                    }
                });
            }
            catch (e) {
                completed(e);
            }
        });
    }
}

class FtpPlugin extends deploy_objects.DeployPluginWithContextBase<FTPContext> {
    public get canPull(): boolean {
        return true;
    }

    protected createContext(target: DeployTargetFTP,
                            files: string[],
                            opts: deploy_contracts.DeployFileOptions): Promise<deploy_objects.DeployPluginContextWrapper<FTPContext>> {
        let me = this;

        return new Promise<deploy_objects.DeployPluginContextWrapper<FTPContext>>((resolve, reject) => {
            let completed = (err: any, conn?: FtpClientBase) => {
                if (err) {
                    reject(err);
                }
                else {
                    let ctx: FTPContext = {
                        cachedRemoteDirectories: {},
                        connection: conn,
                        hasCancelled: false,
                    };

                    me.onCancelling(() => {
                        ctx.hasCancelled = true;

                        conn.end().catch((e) => {
                            me.context.log(i18.t(`errors.withCategory`, 'FtpPlugin.createContext().onCancelling()', e));
                        });
                    }, opts);

                    let wrapper: deploy_objects.DeployPluginContextWrapper<any> = {
                        context: ctx,
                        destroy: function(): Promise<any> {
                            return new Promise<any>((resolve2, reject2) => {
                                delete ctx.cachedRemoteDirectories;

                                conn.end().then(() => {
                                    resolve2(conn);
                                }).catch((e) => {
                                    reject2(e);
                                });
                            });
                        },
                    };

                    resolve(wrapper);
                }
            };

            let client: FtpClientBase;
            let engine = deploy_helpers.normalizeString(target.engine);
            switch (engine) {
                case '':
                case 'ftp':
                    client = new FtpClient();
                    break;

                case 'jsftp':
                    client = new JsFTPClient();
                    break;
            }

            if (client) {
                client.connect(target).then(() => {
                    completed(null, client);
                }).catch((err) => {
                    completed(err);
                });
            }
            else {
                completed(new Error(`Unknown engine: '${engine}'`));  //TODO: translate
            }
        });
    }

    protected deployFileWithContext(ctx: FTPContext,
                                    file: string, target: DeployTargetFTP, opts?: deploy_contracts.DeployFileOptions) {
        let me = this;
        
        let completed = (err?: any) => {
            if (opts.onCompleted) {
                opts.onCompleted(me, {
                    canceled: ctx.hasCancelled,
                    error: err,
                    file: file,
                    target: target,
                });
            }
        };

        if (ctx.hasCancelled) {
            completed();  // cancellation requested
        }
        else {
            let relativeFilePath = deploy_helpers.toRelativeTargetPath(file, target, opts.baseDirectory);
            if (false === relativeFilePath) {
                completed(new Error(i18.t('relativePaths.couldNotResolve', file)));
                return;
            }

            let dir = getDirFromTarget(target);

            let targetFile = toFTPPath(Path.join(dir, relativeFilePath));
            let targetDirectory = toFTPPath(Path.dirname(targetFile));

            let uploadFile = (initDirCache?: boolean) => {
                if (ctx.hasCancelled) {
                    completed();  // cancellation requested
                    return;
                }

                if (deploy_helpers.toBooleanSafe(initDirCache)) {
                    ctx.cachedRemoteDirectories[targetDirectory] = [];
                }

                FS.readFile(file, (err, data) => {
                    if (err) {
                        completed(err);
                    }
                    else {
                        if (ctx.hasCancelled) {
                            completed();  // cancellation requested
                            return;
                        }

                        ctx.connection.put(targetFile, data).then(() => {
                            completed();
                        }).catch((err) => {
                            completed(err);
                        });
                    }
                });
            };

            if (opts.onBeforeDeploy) {
                opts.onBeforeDeploy(me, {
                    destination: targetDirectory,
                    file: file,
                    target: target,
                });
            }

            if (deploy_helpers.isNullOrUndefined(ctx.cachedRemoteDirectories[targetDirectory])) {
                // first check if directory exists ...
                ctx.connection.cwd(targetDirectory).then(() => {
                    if (ctx.hasCancelled) {
                        completed();  // cancellation requested
                    }
                    else {
                        uploadFile(true);
                    }
                }).catch((err) => {
                    if (ctx.hasCancelled) {
                        completed();
                    }
                    else {
                        if (err) {
                            // does not exist => try to create

                            ctx.connection.mkdir(targetDirectory).then(() => {
                                uploadFile(true);
                            }).catch((err) => {
                                completed(err);
                            });
                        }
                        else {
                            uploadFile(true);
                        }
                    }
                });
            }
            else {
                uploadFile();
            }
        }
    }

    protected downloadFileWithContext(ctx: FTPContext,
                                      file: string, target: DeployTargetFTP, opts?: deploy_contracts.DeployFileOptions): Promise<Buffer> {
        let me = this;
        
        return new Promise<Buffer>((resolve, reject) => {
            let completedInvoked = false;
            let completed = (err: any, data?: Buffer) => {
                if (completedInvoked) {
                    return;
                }

                completedInvoked = true;
                if (opts.onCompleted) {
                    opts.onCompleted(me, {
                        canceled: ctx.hasCancelled,
                        error: err,
                        file: file,
                        target: target,
                    });
                }

                if (err) {
                    reject(err);
                }
                else {
                    resolve(data);
                }
            };

            if (ctx.hasCancelled) {
                completed(null);  // cancellation requested
            }
            else {
                let relativeFilePath = deploy_helpers.toRelativeTargetPath(file, target, opts.baseDirectory);
                if (false === relativeFilePath) {
                    completed(new Error(i18.t('relativePaths.couldNotResolve', file)));
                    return;
                }

                let dir = getDirFromTarget(target);

                let targetFile = toFTPPath(Path.join(dir, relativeFilePath));
                let targetDirectory = toFTPPath(Path.dirname(targetFile));

                if (opts.onBeforeDeploy) {
                    opts.onBeforeDeploy(me, {
                        destination: targetDirectory,
                        file: file,
                        target: target,
                    });
                }

                ctx.connection.get(targetFile).then((data) => {
                    completed(null, data);
                }).catch((err) => {
                    completed(err);
                });
            }
        });
    }
    
    public info(): deploy_contracts.DeployPluginInfo {
        return {
            description: i18.t('plugins.ftp.description'),
        };
    }
}

/**
 * Creates a new Plugin.
 * 
 * @param {deploy_contracts.DeployContext} ctx The deploy context.
 * 
 * @returns {deploy_contracts.DeployPlugin} The new instance.
 */
export function createPlugin(ctx: deploy_contracts.DeployContext): deploy_contracts.DeployPlugin {
    return new FtpPlugin(ctx);
}

#!/usr/bin/env node

/// <reference path="../typings/index.d.ts" />
/*
 * BSD 3-Clause License
 *
 * Copyright (c) 2015, Nicolas Riesco and others as credited in the AUTHORS file
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 * may be used to endorse or promote products derived from this software without
 * specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 */

import fs = require("fs");
import path = require("path");
import {version as tsVersion, ScriptTarget, ModuleKind, ModuleResolutionKind, transpile as tsTranspile} from "typescript";
import {TypeScriptSimple} from "typescript-simple";
let Kernel = require("jp-kernel");

let $TScode = `declare var $$async$$: boolean;
declare var $$done$$: any;
declare var $$: any;`;

class Logger {
    private static usage = `
Usage: node kernel.js [--debug] [--semantic] [--hide-undefined] [--protocol=Major[.minor[.patch]]] [--session-working-dir=path] [--show-undefined] [--startup-script=path] connection_file
`;

    static log: (...msgs: any[]) => void = () => {
    };

    static onVerbose() {
        Logger.log = (...msgs: any[]) => {
            process.stderr.write("KERNEL: ");
            console.error(msgs.join(" "));
        };
    }

    static onProcessDebug() {
        try {
            let debugging = require("debug")("KERNEL:");
            Logger.log = (...msgs: any[]) => {
                debugging(msgs.join(" "));
            };
        } catch (err) {
            Logger.onVerbose();
        }
    }

    static throwAndExit(...msgs: any[]) {
        console.error(msgs.join(" "));
        Logger.printUsage();
        process.exit(1);
    }

    static printUsage() {
        console.error(Logger.usage);
    }
}

interface KernelConfig {
    cwd: string;
    hideUndefined: boolean;
    protocolVersion: string;
    startupCallback: () => void;
    debug: boolean;
    kernelInfoReply: Object;
    startupScript?: string;
    connection?: Object;
    transpile?: (code: string) => string;
}

class Configuration {
    private _onDebug: boolean = false;
    private _onTypeChk: boolean = false;
    private _workingDir: string = process.cwd();
    private hideUndefined: boolean = false;
    private protocolVer: string = "5.0";
    private transpiler: TypeScriptSimple;
    private runningHistory: string[] = [$TScode];
    private compiledLength: number = 0;

    private onStartup = function (){
        this.session.execute($TScode, {});
    };

    private isConnSet: boolean = false;
    private conn: Object = {};
    private response: Object;
    private _startupScript: string;

    private static findTSConfig(dir: string){
        let tsconf = path.join(dir, "tsconfig.json");
        if(fs.existsSync(tsconf)){
            return tsconf;
        }else{
            let parent = path.dirname(dir);
            if(parent === dir){
                return undefined;
            }else{
                return Configuration.findTSConfig(parent);
            }
        }
    }

    private static readTSConfig(dir: string){
        let tsconfig = Configuration.findTSConfig(dir);
        let DEFAULT = {
            target: ScriptTarget.ES5,
            module: ModuleKind.CommonJS,
            moduleResolution: ModuleResolutionKind.NodeJs
        };
        if (tsconfig){
            let json = JSON.parse(fs.readFileSync(tsconfig).toString());
            let opt = json['compilerOptions'] || {};

            if (!opt.moduleResolution){
                opt.moduleResolution = DEFAULT.moduleResolution;
            }
            if (!opt.module){
                opt.module = DEFAULT.module;
            }
            if (!opt.target){
                opt.target = DEFAULT.target;
            }

            return opt;
        }else{
            return DEFAULT;
        }
    }

    get config(): KernelConfig {
        this.transpiler = new TypeScriptSimple(Configuration.readTSConfig(this._workingDir), this._onTypeChk);

        let baseObj: KernelConfig = {
            cwd: this._workingDir,
            hideUndefined: this.hideUndefined,
            protocolVersion: this.protocolVer,
            startupCallback: this.onStartup,
            debug: this._onDebug,
            kernelInfoReply: this.response,
            startupScript: this._startupScript,
            transpile: (code: string) => {
                try {
                    let compiled = this.transpiler.compile(this.runningHistory.join("\n") + "\n" + code);

                    // After successfully compiled.
                    this.runningHistory.push(code);
                    let last = compiled.substring(this.compiledLength);
                    this.compiledLength = compiled.length;
                    return last;
                }catch(e){
                    let lines = this.runningHistory.join("\n").split("\n").length;
                    let msg = e.message.split("\n");
                    let newMsg = msg.map((line) => {
                        let number = line.match(/^L([0-9]+): /);
                        if(number.length > 0){
                            let newNumber = `\tLine ${parseInt(number[1]) - lines + 1}: `;
                            return line.replace(/^L([0-9]+): /, newNumber);
                        }else{
                            return line;
                        }
                    }).join("\n");

                    let newError = new Error(newMsg);
                    newError.stack = "[COMPILE ERROR]\n" + newMsg;
                    newError.name = e.name;

                    throw newError;
                }
            }
        };

        if (this.isConnSet) {
            baseObj.connection = this.conn;
        } else {
            Logger.throwAndExit("Error: missing {connectionFile}");
        }

        if (this._startupScript) {
            baseObj.startupScript = this._startupScript;
        }

        return baseObj;
    }

    set connectionWith(path: string) {
        if (this.isConnSet) {
            Logger.throwAndExit("Error: {connectionFile} cannot be duplicated");
        }

        this.isConnSet = true;
        this.conn = JSON.parse(fs.readFileSync(path).toString());
    }

    onDebug() {
        this._onDebug = true;
    }

    onTypeChk() {
        this._onTypeChk = true;
    }

    hideUndef() {
        this.hideUndefined = true;
    }

    showUndef() {
        this.hideUndefined = true;
    }

    set workingDir(path: string) {
        this._workingDir = path;
    }

    set protocolVersion(ver: string) {
        this.protocolVer = ver;
        let majorVersion: number = parseInt(ver.split(".")[0]);

        if (majorVersion <= 4) {
            let tsVer = tsVersion.split(".")
                .map(function (v) {
                    return parseInt(v, 10);
                });
            let protocolVersion = ver.split(".")
                .map(function (v) {
                    return parseInt(v, 10);
                });
            this.response = {
                "language": "typescript",
                "language_version": tsVer,
                "protocol_version": protocolVersion,
            };
        } else {
            let itsVersion = JSON.parse(
                fs.readFileSync(path.join(__dirname, "..", "package.json")).toString()
            ).version;
            this.response = {
                "protocol_version": ver,
                "implementation": "typescript",
                "implementation_version": itsVersion,
                "language_info": {
                    "name": "typescript",
                    "version": tsVersion,
                    "mimetype": "text/x-typescript",
                    "file_extension": ".ts"
                },
                "banner": (
                    "ITypescript v" + itsVersion + "\n" +
                    "https://github.com/nearbydelta/itypescript\n"
                ),
                "help_links": [{
                    "text": "TypeScript Doc",
                    "url": "http://typescriptlang.org/docs/",
                }],
            };

        }
    }

    set startupScript(script: string) {
        this._startupScript = script;
    }
}

class Parser {
    static parse(): KernelConfig {
        let configBuilder = new Configuration();
        let argv = process.argv.slice(2);

        for (let arg of argv) {
            let [name, ...values] = arg.slice(2).split("=");
            switch (name) {
                case "debug":
                    configBuilder.onDebug();
                    Logger.onVerbose();
                    break;
                case "semantic":
                    configBuilder.onTypeChk();
                    break;
                case "hide-undefined":
                    configBuilder.hideUndef();
                    break;
                case "protocol":
                    configBuilder.protocolVersion = values.join("=");
                    break;
                case "session-working-dir":
                    configBuilder.workingDir = values.join("=");
                    break;
                case "show-undefined":
                    configBuilder.showUndef();
                    break;
                case "startup-script":
                    configBuilder.startupScript = values.join("=");
                    break;
                default:
                    configBuilder.connectionWith = arg;
                    break;
            }
        }

        return configBuilder.config;
    }
}

if (process.env["DEBUG"]) {
    Logger.onProcessDebug();
}

let config = Parser.parse();

// Start kernel
let kernel = new Kernel(config);

// Interpret a SIGINT signal as a request to interrupt the kernel
process.on("SIGINT", function () {
    Logger.log("Interrupting kernel");
    kernel.restart(); // TODO(NR) Implement kernel interruption
});


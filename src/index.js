const net = require('net');
const crypto = require('crypto');
const { first, last } = require('lodash');
const struct = require('python-struct');
const Long = require('long');
const { Buffer } = require('buffer');

const PORT = 5000;
const USERNAME = 'admin';
const PASSWORD = '';
const DAHUA_PROTO_DHIP = Long.fromString('5049484400000020', 16);
const DAHUA_HEADER_FORMAT = '<QLLQQ';
const DAHUA_LOGIN_CHALLENGE_CODE = 268632079;
const DAHUA_HEADER_LENGTH = struct.sizeOf(DAHUA_HEADER_FORMAT);
const DAHUA_LOGIN_PARAMS = {
    clientType: 'NetKeyboard',
    ipAddr: '127.0.0.1',
    loginType: 'Direct',
};

module.exports = (api) => {
    api.registerAccessory('DahuaIntercom', DahuaIntercom);
};

class Deferred {
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.reject = reject;
            this.resolve = resolve;
        });
    }
}

class DahuaIntercom {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;

        this.client = null;
        this.currentRequest = null;
        this.chunk = null;
        this.requestId = 0;
        this.sessionId = 0;

        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        // extract name from config
        this.name = config.name;

        // create a new Lock Mechanism service
        this.service = new this.Service.LockMechanism(this.name);

        // create handlers for required characteristics
        this.service
            .getCharacteristic(this.Characteristic.LockCurrentState)
            .onGet(this.handleLockCurrentStateGet.bind(this));

        this.service
            .getCharacteristic(this.Characteristic.LockTargetState)
            .onGet(this.handleLockTargetStateGet.bind(this))
            .onSet(this.handleLockTargetStateSet.bind(this));
    }

    /**
     * REQUIRED - This must return an array of the services exposed.
     * This method must be named "getServices".
     */
    getServices() {
        return [this.service];
    }

    /**
     * Handle requests to get the current value of the "Lock Current State" characteristic
     */
    handleLockCurrentStateGet() {
        this.log.debug('Triggered GET LockCurrentState');

        // the door is always considered secured
        return this.Characteristic.LockCurrentState.SECURED;
    }

    /**
     * Handle requests to get the current value of the "Lock Target State" characteristic
     */
    handleLockTargetStateGet() {
        this.log.debug('Triggered GET LockTargetState');

        // the door is always considered being secured
        return this.Characteristic.LockTargetState.SECURED;
    }

    /**
     * Handle requests to set the "Lock Target State" characteristic
     */
    async handleLockTargetStateSet() {
        // establish the new dahua ip connection
        this.log.debug(
            `Connecting to ${this.config.name} at ${this.config.ip}:${PORT}`
        );

        this.currentRequest = new Deferred();

        this.client = net.createConnection(
            { port: PORT, host: this.config.ip },
            () => {
                this.log.debug('Connected to intercom');
                this.currentRequest.resolve();
            }
        );
        this.client.on('data', (data) => this.receive(data));
        this.client.on('end', () => {
            this.log.debug('Received end of transmission');
            this.currentRequest.reject(
                new Error('Received end of transmission')
            );
        });
        this.client.on('error', () => {
            this.log.debug('Received transmission error');
            this.currentRequest.reject(
                new Error('Received transmission error')
            );
        });

        // wait for the connection to be established
        await this.currentRequest.promise;

        try {
            // login
            await this.send({
                method: 'global.login',
                params: DAHUA_LOGIN_PARAMS,
            });

            // create access control factory
            let response = await this.send({
                method: 'accessControl.factory.instance',
                params: { channel: 0 },
            });

            const object = response.result;

            try {
                // unlock door
                response = await this.send({
                    method: 'accessControl.openDoor',
                    object,
                    params: {
                        DoorIndex: 0,
                        ShortNumber: this.config.shortNumber,
                    },
                });

                this.log.debug('Result', response.result);
                if (!response.result) {
                    throw this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE;
                }

                this.service
                    .getCharacteristic(this.Characteristic.LockTargetState)
                    .updateValue(this.Characteristic.LockTargetState.SECURED);
                this.service
                    .getCharacteristic(this.Characteristic.LockCurrentState)
                    .updateValue(this.Characteristic.LockCurrentState.SECURED);
            } finally {
                // destroy access control factory
                await this.send({
                    method: 'accessControl.destroy',
                    object,
                });
            }
        } finally {
            // close socket
            this.log.debug('Closing socket');
            this.client.destroy();
            this.client = null;
        }
    }

    send(message) {
        this.currentRequest = new Deferred();
        return this.write(message);
    }

    write(message) {
        this.requestId += 1;

        const data = JSON.stringify({
            ...message,
            id: this.requestId,
            session: this.sessionId,
        });

        this.log.debug('Sending ', data);

        this.client.write(
            Buffer.concat([
                struct.pack(DAHUA_HEADER_FORMAT, [
                    DAHUA_PROTO_DHIP,
                    this.sessionId,
                    this.requestId,
                    data.length,
                    data.length,
                ]),
                Buffer.from(data),
            ])
        );

        return this.currentRequest.promise;
    }

    receive(data) {
        this.log.debug('Receiving data');
        this.chunk =
            this.chunk == null ? data : Buffer.concat([this.chunk, data]);

        if (this.chunk.length < DAHUA_HEADER_LENGTH) {
            return;
        }

        const headerParts = struct.unpack(DAHUA_HEADER_FORMAT, data);

        if (!DAHUA_PROTO_DHIP.equals(first(headerParts))) {
            this.currentRequest.reject(new Error('Wrong proto'));
            return;
        }

        const tail = DAHUA_HEADER_LENGTH + last(headerParts).toNumber();

        if (tail > this.chunk.length) {
            return;
        }

        const message = JSON.parse(
            this.chunk.toString('utf8', DAHUA_HEADER_LENGTH, tail)
        );
        this.chunk = null;

        this.log.debug('Received data', message);

        const { error, params, session } = message;

        if (error != null) {
            if (error.code === DAHUA_LOGIN_CHALLENGE_CODE) {
                this.sessionId = session;

                let password = crypto
                    .createHash('md5')
                    .update(`${USERNAME}:${params.realm}:${PASSWORD}`)
                    .digest('hex')
                    .toUpperCase();
                password = crypto
                    .createHash('md5')
                    .update(`${USERNAME}:${params.random}:${password}`)
                    .digest('hex')
                    .toUpperCase();

                this.write({
                    method: 'global.login',
                    params: {
                        ...DAHUA_LOGIN_PARAMS,
                        userName: USERNAME,
                        password,
                    },
                });

                return;
            } else {
                this.currentRequest.reject(
                    new Error(`Received error ${error.code}: ${error.message}`)
                );
                return;
            }
        }

        this.currentRequest.resolve(message);
    }
}
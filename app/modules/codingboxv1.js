const BaseModule = require('./baseModule');

class CodingBoxV1 extends BaseModule {
    constructor() {
        super();
        this.serialport = null;
        this.commands = [];
        this.sensorData = {};
        this.lastSendTime = 0;
        this.sendInterval = 200;
    }

    handleRemoteData(handler) {
        const command = handler.read('type');
        const payload = handler.read('payload');

        if (!command) {
            return;
        }

        const data = `${command};${payload ?? ''}\n`;

        // 실행 중지 명령은 기존 대기 명령을 모두 버리고 가장 먼저 처리한다.
        if (command === 'reset') {
            this.commands = ['reset;\n'];
            return;
        }

        // 같은 명령이 이미 대기 중이면 중복으로 넣지 않는다.
        if (
            command !== 'tone' &&
            this.commands.indexOf(data) > -1
        ) {
            return;
        }

        this.commands.push(data);

        // 명령이 과도하게 쌓이지 않도록 제한한다.
        if (this.commands.length > 20) {
            this.commands.shift();
        }
    }

    requestLocalData() {
        const now = Date.now();

        if (
            this.commands.length > 0 &&
            now - this.lastSendTime >= this.sendInterval
        ) {
            this.lastSendTime = now;

            const batch = this.commands.splice(0, 5);

            return `batch;${batch.map((command) => command.trim()).join('@@')}\n`;
        }

        return 'localdata;\n';
    }

    handleLocalData(data) {
        const text = data.toString().trim();

        if (text.indexOf('localdata;') !== 0) {
            return;
        }

        const payload = text.replace('localdata;', '');

        try {
            this.sensorData = JSON.parse(payload);
        } catch (e) {
            // 불완전한 시리얼 데이터는 다음 수신까지 무시한다.
        }
    }

    requestRemoteData(handler) {
        Object.keys(this.sensorData).forEach((key) => {
            handler.write(key, this.sensorData[key]);
        });
    }

    requestInitialData() {
        return 'identify;\n';
    }

    checkInitialData(data) {
        const text = data.toString().trim();
        const prefix = 'identify;';

        if (!text.startsWith(prefix)) {
            return undefined;
        }

        try {
            const payload = JSON.parse(text.slice(prefix.length));

            if (payload.device === 'playcodingboxv1') {
                return true;
            }

            return undefined;
        } catch (e) {
            return undefined;
        }
    }

    setSerialPort(serialport) {
        this.serialport = serialport;
    }

    disconnect(connect) {
        this.commands = [];
        this.sensorData = {};

        if (this.serialport) {
            this.serialport.write('reset;\n');
        }

        if (connect) {
            connect.close();
        }
    }

    reset() {
        this.commands = [];
        this.sensorData = {};
        this.lastSendTime = 0;
    }
}

module.exports = new CodingBoxV1();

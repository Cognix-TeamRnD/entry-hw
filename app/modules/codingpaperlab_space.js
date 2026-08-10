function Module() {
    /*
     * Arduino에서 받은 센서값
     *
     * 버튼은 INPUT_PULLUP 방식이므로 기본 미입력값을 1로 둔다.
     */
    this.digitalValue = new Array(14).fill(1);
    this.analogValue = new Array(6).fill(0);

    this.temperature = 0;
    this.humidity = 0;

    /*
     * 시리얼 수신 버퍼
     */
    this.receiveBuffer = '';

    /*
     * Arduino로 보낼 일반 명령 대기열
     */
    this.sendQueue = [];

    /*
     * RESET은 일반 명령 큐와 별도로 최우선 처리한다.
     */
    this.forceReset = false;

    /*
     * 같은 실행 명령이 반복 등록되는 것을 막기 위한 기록
     */
    this.lastCommandTime = {};

    /*
     * 연결 상태
     */
    this.connected = false;
    this.lastError = '';
    this.lastResponse = '';
    this.lastHeartbeatTime = 0;

    this.handler = null;
    this.config = null;

    this.lastJoystickRequestTime = 0;
    this.lastSentServoAngle = {};
}

/*
 * Entry Hardware 초기화
 */
Module.prototype.init = function(handler, config) {
    this.handler = handler;
    this.config = config;
};

/*
 * 연결 시 Arduino에 식별 요청
 */
Module.prototype.requestInitialData = function() {
    return Buffer.from('PING\n');
};

/*
 * Arduino 공통 펌웨어 확인
 *
 * true:
 *   올바른 공통 펌웨어 응답
 *
 * undefined:
 *   다른 펌웨어가 올라가 있거나 아직 응답이 불완전함
 *   즉시 Invalid hardware로 종료하지 않고 펌웨어 업데이트가 가능하게 함
 */
Module.prototype.checkInitialData = function(data) {
    if (!data) {
        return undefined;
    }

    var text = data.toString().trim();

    if (
        text.indexOf('PONG,CODINGPAPERLAB_SPACE') > -1 ||
        text.indexOf('READY,CODINGPAPERLAB_SPACE') > -1
    ) {
        this.connected = true;
        return true;
    }

    return undefined;
};

Module.prototype.validateLocalData = function(data) {
    return true;
};

/*
 * EntryJS에서 전달된 명령 처리
 */
Module.prototype.handleRemoteData = function(handler) {
    var commandData = handler.read('COMMAND');

    if (!commandData) {
        return;
    }

    /*
     * RESET은 기존 대기 명령을 모두 버리고 최우선 처리한다.
     * 무한 반복 블록이 계속 명령을 보내던 중 정지해도
     * 이전 LED/서보/신호등 명령이 RESET 뒤에 실행되지 않게 한다.
     */
    if (
        !Array.isArray(commandData) &&
        String(commandData.type).toUpperCase() === 'RESET'
    ) {
        this.sendQueue = [];
        this.lastCommandTime = {};
        this.forceReset = true;
        return;
    }

    if (Array.isArray(commandData)) {
        for (var i = 0; i < commandData.length; i++) {
            var item = commandData[i];

            if (
                item &&
                String(item.type).toUpperCase() === 'RESET'
            ) {
                this.sendQueue = [];
                this.lastCommandTime = {};
                this.forceReset = true;
                return;
            }

            this.processRemoteCommand(item);
        }

        return;
    }

    this.processRemoteCommand(commandData);
};

/*
 * EntryJS 명령을 Arduino 문자열 명령으로 변환
 */
Module.prototype.processRemoteCommand = function(command) {
    if (!command || !command.type) {
        return;
    }

    var type = String(command.type).toUpperCase();

    /*
     * RESET이 예약된 상태에서는 새 일반 명령을 받지 않는다.
     * 정지 직후 무한 반복 블록의 잔여 명령이 다시 쌓이는 것을 막는다.
     */
    if (this.forceReset && type !== 'RESET') {
        return;
    }

    var commandTime =
        command.time !== undefined ? command.time : command.id;

    /*
     * 같은 실행 시각의 동일 명령 중복 방지
     */
    if (commandTime !== undefined) {
        var commandKey = type;

        if (command.key !== undefined) {
            commandKey += '_' + command.key;
        } else if (command.pin !== undefined) {
            commandKey += '_' + command.pin;
        } else if (
            command.clk !== undefined &&
            command.dio !== undefined
        ) {
            commandKey += '_' + command.clk + '_' + command.dio;
        }

        if (this.lastCommandTime[commandKey] === commandTime) {
            return;
        }

        this.lastCommandTime[commandKey] = commandTime;
    }

    var message = null;

    switch (type) {
        /*
         * 디지털 입력
         * DR,핀,풀업
         */
        case 'DIGITAL_READ': {
            var digitalReadPin = this.toDigitalPin(command.pin);
            var pullup = Number(command.pullup) === 1 ? 1 : 0;

            if (digitalReadPin === null) {
                return;
            }

            message = 'DR,' + digitalReadPin + ',' + pullup;
            break;
        }

        /*
         * 아날로그 입력
         * AR,아날로그핀번호
         */
        case 'ANALOG_READ': {
            var analogPin = this.toAnalogPin(command.pin);

            if (analogPin === null) {
                return;
            }

            message = 'AR,' + analogPin;
            break;
        }

        /*
         * 디지털 출력
         * DW,핀,값
         */
        case 'DIGITAL_WRITE': {
            var digitalWritePin = this.toDigitalPin(command.pin);

            if (digitalWritePin === null) {
                return;
            }

            var digitalOutputValue =
                Number(command.value) === 0 ? 0 : 1;

            message =
                'DW,' +
                digitalWritePin +
                ',' +
                digitalOutputValue;

            break;
        }

        /*
         * PWM 출력
         * PW,핀,값
         */
        case 'PWM_WRITE': {
            var pwmPin = this.toDigitalPin(command.pin);

            if (pwmPin === null) {
                return;
            }

            var pwmValue = this.constrain(
                Number(command.value),
                0,
                255
            );

            message = 'PW,' + pwmPin + ',' + pwmValue;
            break;
        }

        /*
         * 서보모터
         * SV,핀,각도
         */
        case 'SERVO': {
            var servoPin = this.toDigitalPin(command.pin);

            if (servoPin === null) {
                return;
            }

            var angle = this.constrain(
                Number(command.angle),
                0,
                180
            );

            message = 'SV,' + servoPin + ',' + angle;
            break;
        }

        /*
         * 부저
         * TN,핀,주파수,시간(ms)
         */
        case 'TONE': {
            var buzzerPin = this.toDigitalPin(command.pin);

            if (buzzerPin === null) {
                return;
            }

            var frequency = Math.max(
                0,
                Number(command.frequency) || 0
            );

            var duration = Math.max(
                0,
                Number(command.duration) || 0
            );

            message =
                'TN,' +
                buzzerPin +
                ',' +
                frequency +
                ',' +
                duration;

            break;
        }

        /*
         * 부저 끄기
         */
        case 'NO_TONE': {
            var noTonePin = this.toDigitalPin(command.pin);

            if (noTonePin === null) {
                return;
            }

            message = 'NT,' + noTonePin;
            break;
        }

        /*
         * LED 스트립 전체 색상
         * NP,핀,개수,R,G,B
         */
        case 'NEOPIXEL': {
            var neoPixelPin = this.toDigitalPin(command.pin);

            if (neoPixelPin === null) {
                return;
            }

            var ledCount = this.constrain(
                Number(command.count) || 1,
                1,
                60
            );

            var red = this.constrain(
                Number(command.red) || 0,
                0,
                255
            );

            var green = this.constrain(
                Number(command.green) || 0,
                0,
                255
            );

            var blue = this.constrain(
                Number(command.blue) || 0,
                0,
                255
            );

            message =
                'NP,' +
                neoPixelPin +
                ',' +
                ledCount +
                ',' +
                red +
                ',' +
                green +
                ',' +
                blue;

            break;
        }

        /*
         * LED 스트립 끄기
         */
        case 'NEOPIXEL_CLEAR': {
            var clearNeoPixelPin = this.toDigitalPin(command.pin);

            if (clearNeoPixelPin === null) {
                return;
            }

            var clearLedCount = this.constrain(
                Number(command.count) || 1,
                1,
                60
            );

            message =
                'NC,' +
                clearNeoPixelPin +
                ',' +
                clearLedCount;

            break;
        }

        /*
         * TM1637 숫자 표시
         */
        case 'SEGMENT': {
            var clkPin = this.toDigitalPin(command.clk);
            var dioPin = this.toDigitalPin(command.dio);

            if (
                clkPin === null ||
                dioPin === null ||
                clkPin === dioPin
            ) {
                return;
            }

            var number = Math.round(Number(command.number) || 0);

            message =
                'SG,' +
                clkPin +
                ',' +
                dioPin +
                ',' +
                number;

            break;
        }

        /*
         * TM1637 지우기
         */
        case 'SEGMENT_CLEAR': {
            var clearClkPin = this.toDigitalPin(command.clk);
            var clearDioPin = this.toDigitalPin(command.dio);

            if (
                clearClkPin === null ||
                clearDioPin === null ||
                clearClkPin === clearDioPin
            ) {
                return;
            }

            message =
                'SC,' +
                clearClkPin +
                ',' +
                clearDioPin;

            break;
        }

        /*
         * DHT11 읽기
         */
        case 'DHT_READ': {
            var dhtPin = this.toDigitalPin(command.pin);

            if (dhtPin === null) {
                return;
            }

            message = 'DH,' + dhtPin;
            break;
        }

        /*
         * 실행 정지
         */
        case 'RESET': {
            this.sendQueue = [];
            this.lastCommandTime = {};
            this.forceReset = true;
            return;
        }

        /*
         * 연결 확인
         */
        case 'PING': {
            message = 'PING';
            break;
        }

        default:
            return;
    }

    this.enqueueCommand(message);
};

/*
 * 일반 명령 대기열 추가
 */
Module.prototype.enqueueCommand = function(message) {
    if (!message || this.forceReset) {
        return;
    }

    /*
     * 센서 읽기 명령은 같은 요청이 이미 있으면 추가하지 않는다.
     */
    if (
        (
            message.indexOf('DR,') === 0 ||
            message.indexOf('AR,') === 0 ||
            message.indexOf('DH,') === 0
        ) &&
        this.sendQueue.indexOf(message) > -1
    ) {
        return;
    }

    /*
     * 서보: 같은 핀의 대기 명령을 현재 위치에서 최신 각도로 교체
     */
    if (message.indexOf('SV,') === 0) {
        var servoParts = message.split(',');
        var servoPin = servoParts[1];
        var servoAngle = servoParts[2];

        if (
            String(this.lastSentServoAngle[servoPin]) ===
            String(servoAngle)
        ) {
            return;
        }

        for (var i = 0; i < this.sendQueue.length; i++) {
            var queuedServo = this.sendQueue[i];

            if (
                queuedServo.indexOf(
                    'SV,' + servoPin + ','
                ) === 0
            ) {
                this.sendQueue[i] = message;
                return;
            }
        }
    }

    /*
     * 디지털 출력: 같은 핀 명령을 현재 위치에서 교체
     * 진동, 전자석, 신호등에 적용
     */
    if (message.indexOf('DW,') === 0) {
        var digitalParts = message.split(',');
        var digitalPin = digitalParts[1];

        for (var j = 0; j < this.sendQueue.length; j++) {
            var queuedDigital = this.sendQueue[j];

            if (
                queuedDigital.indexOf(
                    'DW,' + digitalPin + ','
                ) === 0
            ) {
                this.sendQueue[j] = message;
                return;
            }
        }
    }

    /*
     * NeoPixel: 같은 핀의 NP/NC 명령을 현재 위치에서 교체
     */
    if (
        message.indexOf('NP,') === 0 ||
        message.indexOf('NC,') === 0
    ) {
        var neoParts = message.split(',');
        var neoPin = neoParts[1];

        for (var k = 0; k < this.sendQueue.length; k++) {
            var queuedNeo = this.sendQueue[k];

            if (
                queuedNeo.indexOf('NP,') !== 0 &&
                queuedNeo.indexOf('NC,') !== 0
            ) {
                continue;
            }

            var queuedNeoParts = queuedNeo.split(',');

            if (
                String(queuedNeoParts[1]) ===
                String(neoPin)
            ) {
                this.sendQueue[k] = message;
                return;
            }
        }
    }

    /*
     * 7세그먼트: 같은 CLK/DIO 조합을 현재 위치에서 교체
     */
    if (
        message.indexOf('SG,') === 0 ||
        message.indexOf('SC,') === 0
    ) {
        var segmentParts = message.split(',');
        var segmentClk = segmentParts[1];
        var segmentDio = segmentParts[2];

        for (var n = 0; n < this.sendQueue.length; n++) {
            var queuedSegment = this.sendQueue[n];

            if (
                queuedSegment.indexOf('SG,') !== 0 &&
                queuedSegment.indexOf('SC,') !== 0
            ) {
                continue;
            }

            var queuedSegmentParts =
                queuedSegment.split(',');

            if (
                String(queuedSegmentParts[1]) ===
                    String(segmentClk) &&
                String(queuedSegmentParts[2]) ===
                    String(segmentDio)
            ) {
                this.sendQueue[n] = message;
                return;
            }
        }
    }

    /*
     * 부저 TN 명령은 순서를 보존하기 위해 모두 추가한다.
     */
    if (this.sendQueue.length >= 50) {
        this.sendQueue.shift();
    }

    this.sendQueue.push(message);
};

/*
 * Arduino로 명령 전송
 */
Module.prototype.requestLocalData = function() {
    var now = Date.now();

    // 1. RESET 최우선
    if (this.forceReset) {
        this.forceReset = false;
        this.sendQueue = [];

        this.lastHeartbeatTime = now;
        this.lastJoystickRequestTime = now;
        this.lastSentServoAngle = {};

        return Buffer.from('RESET\n');
    }

    // 2. 연결 확인
    if (now - this.lastHeartbeatTime >= 500) {
        this.lastHeartbeatTime = now;
        return Buffer.from('PING\n');
    }

    /*
     * 3. 근접 센서, 버튼, 서보 등
     * 블록에서 요청한 명령을 먼저 전송
     */
    if (this.sendQueue.length > 0) {
        var command = this.sendQueue.shift();

        if (command.indexOf('SV,') === 0) {
            var servoParts = command.split(',');
            var servoPin = servoParts[1];
            var servoAngle = servoParts[2];

            this.lastSentServoAngle[servoPin] = servoAngle;
        }

        return Buffer.from(command + '\n');
    }

    // 4. 조이스틱 자동 요청은 가장 마지막
    if (now - this.lastJoystickRequestTime >= 40) {
        this.lastJoystickRequestTime = now;
        return Buffer.from('AR,0\n');
    }

    return null;
};

/*
 * Arduino 응답 수신
 */
Module.prototype.handleLocalData = function(data) {
    if (!data || data.length === 0) {
        return;
    }

    this.receiveBuffer += data.toString();

    var lines = this.receiveBuffer.split(/\r?\n/);

    /*
     * 마지막 줄은 아직 완성되지 않았을 수 있으므로 보관한다.
     */
    this.receiveBuffer = lines.pop();

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();

        if (line.length > 0) {
            this.parseResponse(line);
        }
    }
};

/*
 * Arduino 응답 해석
 */
Module.prototype.parseResponse = function(line) {
    var parts = line.split(',');
    var type = parts[0];

    switch (type) {
        /*
         * DR,핀,값
         */
        case 'DR': {
            var digitalPin = Number(parts[1]);
            var receivedDigitalValue = Number(parts[2]);

            if (
                digitalPin >= 0 &&
                digitalPin < this.digitalValue.length &&
                !isNaN(receivedDigitalValue)
            ) {
                this.digitalValue[digitalPin] =
                    receivedDigitalValue === 0 ? 0 : 1;
            }

            break;
        }

        /*
         * AR,핀,값
         */
        case 'AR': {
            var analogPin = Number(parts[1]);
            var receivedAnalogValue = Number(parts[2]);

            if (
                analogPin >= 0 &&
                analogPin < this.analogValue.length &&
                !isNaN(receivedAnalogValue)
            ) {
                this.analogValue[analogPin] =
                    receivedAnalogValue;
            }

            break;
        }

        /*
         * DH,온도,습도
         */
        case 'DH': {
            var temperature = Number(parts[1]);
            var humidity = Number(parts[2]);

            if (!isNaN(temperature)) {
                this.temperature = temperature;
            }

            if (!isNaN(humidity)) {
                this.humidity = humidity;
            }

            break;
        }

        case 'READY':
        case 'PONG': {
            if (
                line.indexOf('CODINGPAPERLAB_SPACE') > -1
            ) {
                this.connected = true;
            }

            this.lastResponse = line;
            break;
        }

        case 'OK': {
            this.lastResponse = line;

            if (parts[1] === 'RESET') {
                /*
                 * RESET 완료 후 센서 표시값도 기본값으로 정리한다.
                 */
                this.digitalValue = new Array(14).fill(1);
                this.analogValue = new Array(6).fill(0);
                this.temperature = 0;
                this.humidity = 0;
            }

            break;
        }

        case 'ERR': {
            this.lastError = parts.slice(1).join(',');
            this.lastResponse = line;
            break;
        }

        default:
            this.lastResponse = line;
            break;
    }
};

/*
 * 센서값을 EntryJS에 전달
 */
Module.prototype.requestRemoteData = function(handler) {
    /*
     * 디지털 D0~D13
     * 숫자 키와 d0 형태를 모두 제공한다.
     */
    for (var i = 0; i < this.digitalValue.length; i++) {
        handler.write(i, this.digitalValue[i]);
        handler.write('d' + i, this.digitalValue[i]);
    }

    /*
     * 아날로그 A0~A5
     */
    for (var j = 0; j < this.analogValue.length; j++) {
        handler.write('a' + j, this.analogValue[j]);
    }

    handler.write('temperature', this.temperature);
    handler.write('humidity', this.humidity);

    handler.write('connected', this.connected);
    handler.write('lastError', this.lastError);
    handler.write('lastResponse', this.lastResponse);
};

/*
 * 디지털 핀 변환
 *
 * 9, "9", "D9" 모두 허용
 */
Module.prototype.toDigitalPin = function(value) {
    if (typeof value === 'string') {
        value = value.toUpperCase().replace('D', '');
    }

    var pin = Number(value);

    /*
     * D0과 D1은 USB 시리얼 통신 핀이므로 사용하지 않는다.
     */
    if (
        !Number.isInteger(pin) ||
        pin < 2 ||
        pin > 13
    ) {
        return null;
    }

    return pin;
};

/*
 * 아날로그 핀 변환
 *
 * 0, "0", "A0" 모두 허용
 */
Module.prototype.toAnalogPin = function(value) {
    if (typeof value === 'string') {
        value = value.toUpperCase().replace('A', '');
    }

    var pin = Number(value);

    if (
        !Number.isInteger(pin) ||
        pin < 0 ||
        pin > 5
    ) {
        return null;
    }

    return pin;
};

Module.prototype.constrain = function(value, min, max) {
    if (isNaN(value)) {
        return min;
    }

    return Math.min(Math.max(value, min), max);
};

/*
 * 엔트리 실행 정지 또는 하드웨어 초기화
 *
 * 장치별 초기화 명령을 여러 개 큐에 넣지 않고,
 * 펌웨어의 RESET 명령 하나만 최우선으로 보낸다.
 * 실제 장치 초기화는 Arduino resetAllDevices()가 담당한다.
 */
Module.prototype.reset = function() {
    this.sendQueue = [];
    this.lastCommandTime = {};
    this.forceReset = true;

    this.receiveBuffer = '';

    /*
     * 버튼 INPUT_PULLUP의 미입력 기본값은 1이다.
     */
    this.digitalValue = new Array(14).fill(1);
    this.analogValue = new Array(6).fill(0);

    this.temperature = 0;
    this.humidity = 0;

    this.lastError = '';
    this.lastResponse = '';
    this.lastHeartbeatTime = 0;

    this.lastJoystickRequestTime = 0;
    this.lastSentServoAngle = {};
};

/*
 * 시리얼 연결 종료 시 가능한 경우 RESET을 먼저 보낸다.
 */
Module.prototype.setSerialPort = function(serialport) {
    this.serialport = serialport;
};

Module.prototype.disconnect = function(connect) {
    this.sendQueue = [];
    this.lastCommandTime = {};

    if (this.serialport) {
        try {
            this.serialport.write('RESET\n');
        } catch (e) {
            // 포트가 이미 닫힌 경우 무시한다.
        }
    }

    if (connect) {
        connect.close();
    }
};

module.exports = new Module();

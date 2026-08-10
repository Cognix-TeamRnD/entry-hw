const BaseModule = require('./baseModule');

class MyCobot280M5 extends BaseModule {
    constructor() {
        super();

        this.serialport = null;

        // 로봇으로 전송할 바이너리 명령 큐
        this.commands = [];

        // 시리얼 수신 데이터가 나누어 들어올 수 있으므로 임시 저장
        this.receiveBuffer = Buffer.alloc(0);

        this.sensorData = {
            connected: false,
            angles: [0, 0, 0, 0, 0, 0],
            angle1: 0,
            angle2: 0,
            angle3: 0,
            angle4: 0,
            angle5: 0,
            angle6: 0,
            coords: [0, 0, 0, 0, 0, 0],
            x: 0,
            y: 0,
            z: 0,
            rx: 0,
            ry: 0,
            rz: 0,            
        };

        this.lastSendTime = 0;
        this.sendInterval = 100;

        // 각도 자동 조회 주기
        this.lastPollTime = 0;
        this.pollInterval = 200;

        // 같은 명령이 너무 빠르게 중복 등록되는 것 방지
        this.lastRemoteCommandKey = null;

        this.pollTarget = 'angles';
    }

    /**
     * 현재 모든 관절 각도 조회
     *
     * FE FE 02 20 FA
     */
    makeGetAnglesPacket() {
        return Buffer.from([0xfe, 0xfe, 0x02, 0x20, 0xfa]);
    }

    /**
     * 관절 이동
     *
     */
    makeSendAnglesPacket(angles, speed) {
        const safeSpeed = Math.max(
            1,
            Math.min(100, Math.trunc(Number(speed)))
        );

        const safeAngles = Array.from({ length: 6 }, (_, index) => {
            let angle = Number(angles[index]);

            if (!Number.isFinite(angle)) {
                angle = 0;
            }

            angle = Math.max(-180, Math.min(180, angle));

            return Math.round(angle * 100);
        });

        const packet = [
            0xfe,
            0xfe,
            0x0f,
            0x22,
        ];

        safeAngles.forEach((angleValue) => {
            const angleBuffer = Buffer.alloc(2);
            angleBuffer.writeInt16BE(angleValue, 0);

            packet.push(angleBuffer[0]);
            packet.push(angleBuffer[1]);
        });

        packet.push(safeSpeed);
        packet.push(0xfa);

        return Buffer.from(packet);
    }

    makeSendCoordsPacket(coords, speed, mode) {
        const safeCoords = Array.from({ length: 6 }, (_, index) => {
            const value = Number(coords[index]);
            return Number.isFinite(value) ? value : 0;
        });

        const safeSpeed = Math.max(
            1,
            Math.min(100, Math.trunc(Number(speed)))
        );

        const safeMode = Number(mode) === 1 ? 1 : 0;

        const packet = [
            0xfe,
            0xfe,
            0x10,
            0x25,
        ];

        safeCoords.forEach((value, index) => {
            const scale = index < 3 ? 10 : 100;
            const encoded = Math.round(value * scale);

            const buffer = Buffer.alloc(2);
            buffer.writeInt16BE(encoded, 0);

            packet.push(buffer[0]);
            packet.push(buffer[1]);
        });

        packet.push(safeSpeed);
        packet.push(safeMode);
        packet.push(0xfa);

        return Buffer.from(packet);
    }    

    makeGetCoordsPacket() {
        return Buffer.from([
            0xfe,
            0xfe,
            0x02,
            0x23,
            0xfa,
        ]);
    }

    /**
     * EntryJS에서 보낸 명령 수신
     *
     * type: 'set_joint'
     * payload: {
     *     joint: 1,
     *     angle: 20,
     *     speed: 20,
     *     time: 123456789
     * }
     */
    handleRemoteData(handler) {
        const command = handler.read('type');
        const payload = handler.read('payload');

        if (!command) {
            return;
        }

        const commandTime =
            payload && typeof payload === 'object'
                ? payload.time
                : undefined;

        const remoteCommandKey =
            commandTime !== undefined
                ? `${command}:${commandTime}`
                : null;

        // Entry sendQueue에 남아 있는 동일한 명령은 다시 처리하지 않음
        if (
            remoteCommandKey &&
            remoteCommandKey === this.lastRemoteCommandKey
        ) {
            return;
        }

        if (command === 'set_angles') {
            if (!payload || typeof payload !== 'object') {
                return;
            }

            const angles = [
                Number(payload.angle1),
                Number(payload.angle2),
                Number(payload.angle3),
                Number(payload.angle4),
                Number(payload.angle5),
                Number(payload.angle6),
            ];

            const speed = Number(payload.speed);

            if (
                angles.some((angle) => !Number.isFinite(angle)) ||
                !Number.isFinite(speed)
            ) {
                return;
            }

            this.commands.push(
                this.makeSendAnglesPacket(angles, speed)
            );

            if (this.commands.length > 20) {
                this.commands.shift();
            }

            this.lastRemoteCommandKey = remoteCommandKey;
            return;
        }

        if (command === 'home') {
            const speed =
                payload && Number.isFinite(Number(payload.speed))
                    ? Number(payload.speed)
                    : 20;

            this.commands.push(
                this.makeSendAnglesPacket(
                    [0, 0, 0, 0, 0, 0],
                    speed
                )
            );

            if (this.commands.length > 20) {
                this.commands.shift();
            }

            this.lastRemoteCommandKey = remoteCommandKey;
            return;
        }

        if (command === 'set_coords') {
            if (!payload || typeof payload !== 'object') {
                return;
            }

            const coords = [
                Number(payload.x),
                Number(payload.y),
                Number(payload.z),
                Number(payload.rx),
                Number(payload.ry),
                Number(payload.rz),
            ];

            const speed = Number(payload.speed);
            const mode = Number(payload.mode);

            if (
                coords.some((value) => !Number.isFinite(value)) ||
                !Number.isFinite(speed)
            ) {
                return;
            }

            this.commands.push(
                this.makeSendCoordsPacket(
                    coords,
                    speed,
                    mode
                )
            );

            if (this.commands.length > 20) {
                this.commands.shift();
            }

            this.lastRemoteCommandKey = remoteCommandKey;
            return;
        }        

        if (command === 'gripper_state') {
            if (!payload || typeof payload !== 'object') {
                return;
            }

            const state = Number(payload.state);
            const speed = Number(payload.speed);

            if (
                !Number.isFinite(state) ||
                !Number.isFinite(speed)
            ) {
                return;
            }

            this.commands.push(
                this.makeSetGripperStatePacket(state, speed)
            );

            if (this.commands.length > 20) {
                this.commands.shift();
            }

            this.lastRemoteCommandKey = remoteCommandKey;
            return;
        }

        if (command === 'gripper_value') {
            if (!payload || typeof payload !== 'object') {
                return;
            }

            const value = Number(payload.value);
            const speed = Number(payload.speed);

            if (
                !Number.isFinite(value) ||
                !Number.isFinite(speed)
            ) {
                return;
            }

            this.commands.push(
                this.makeSetGripperValuePacket(value, speed)
            );

            if (this.commands.length > 20) {
                this.commands.shift();
            }

            this.lastRemoteCommandKey = remoteCommandKey;
            return;
        }

        if (command === 'stop') {
            // 대기 중인 이동 명령 전부 제거
            this.commands = [];

            // 정지 패킷을 최우선으로 등록
            this.commands.unshift(this.makeStopPacket());

            // 다음 requestLocalData 호출에서 즉시 전송되도록 함
            this.lastSendTime = 0;

            this.lastRemoteCommandKey = remoteCommandKey;
            return;
        }
    }

    /**
     * Entry Hardware가 로봇으로 보낼 데이터 요청
     */
    requestLocalData() {
        const now = Date.now();

        if (
            this.commands.length > 0 &&
            now - this.lastSendTime >= 100
        ) {
            this.lastSendTime = now;
            return this.commands.shift();
        }

        if (now - this.lastPollTime >= 200) {
            this.lastPollTime = now;

            if (this.pollTarget === 'angles') {
                this.pollTarget = 'coords';
                return this.makeGetAnglesPacket();
            }

            this.pollTarget = 'angles';
            return this.makeGetCoordsPacket();
        }

        return Buffer.alloc(0);
    }

    /**
     * 로봇에서 들어온 시리얼 데이터 처리
     */
    handleLocalData(data) {
        if (!data || data.length === 0) {
            return;
        }

        this.receiveBuffer = Buffer.concat([
            this.receiveBuffer,
            Buffer.from(data),
        ]);

        this.parsePackets();
    }

    /**
     * 수신 버퍼에서 완성된 myCobot 패킷 분리
     */
    parsePackets() {
        while (this.receiveBuffer.length >= 5) {
            const headerIndex = this.findHeader(this.receiveBuffer);

            if (headerIndex < 0) {
                this.receiveBuffer = Buffer.alloc(0);
                return;
            }

            if (headerIndex > 0) {
                this.receiveBuffer = this.receiveBuffer.subarray(headerIndex);
            }

            if (this.receiveBuffer.length < 3) {
                return;
            }

            const dataLength = this.receiveBuffer[2];

            // 전체 길이 = FE FE 2바이트 + length에 포함된 부분 + FA 1바이트
            const packetLength = dataLength + 3;

            if (packetLength < 5 || packetLength > 100) {
                this.receiveBuffer = this.receiveBuffer.subarray(1);
                continue;
            }

            if (this.receiveBuffer.length < packetLength) {
                return;
            }

            const packet = this.receiveBuffer.subarray(0, packetLength);

            this.receiveBuffer =
                this.receiveBuffer.subarray(packetLength);

            if (packet[packet.length - 1] !== 0xfa) {
                continue;
            }

            this.handlePacket(packet);
        }
    }

    findHeader(buffer) {
        for (let index = 0; index < buffer.length - 1; index += 1) {
            if (buffer[index] === 0xfe && buffer[index + 1] === 0xfe) {
                return index;
            }
        }

        return -1;
    }

    /**
     * 완성된 패킷 종류별 처리
     */
    handlePacket(packet) {
        if (packet.length < 5) {
            return;
        }

        const command = packet[3];

        // GET_ANGLES 응답
        if (command === 0x20) {
            this.parseAnglesPacket(packet);
            return;
        }

        // SEND_ANGLE 응답
        // 예: FE FE 03 21 01 FA
        if (
            command === 0x21 ||
            command === 0x22 ||
            command === 0x25 ||
            command === 0x66 ||
            command === 0x67
        ) {
            this.sensorData.connected = true;
            return;
        }

        if (command === 0x23) {
            this.parseCoordsPacket(packet);
            return;
        }        
    }

    /**
     * 현재 6축 각도 응답 처리
     *
     * 예:
     * FE FE 0E 20
     * 07 B9 FF E6 FF F8 00 1A 00 1A FF E6
     * FA
     */
    parseAnglesPacket(packet) {
        const angles = [];

        // command는 packet[3]
        // 각도 데이터는 packet[4]부터 시작
        for (
            let index = 4;
            index + 1 < packet.length - 1;
            index += 2
        ) {
            const rawAngle = packet.readInt16BE(index);
            angles.push(rawAngle / 100);
        }

        if (angles.length !== 6) {
            return;
        }

        this.sensorData.connected = true;
        this.sensorData.angles = angles;

        angles.forEach((angle, index) => {
            this.sensorData[`angle${index + 1}`] = angle;
        });
    }

    parseCoordsPacket(packet) {
        if (packet.length < 17) {
            return;
        }

        const coords = [];

        for (let index = 4; index < 16; index += 2) {
            const raw = packet.readInt16BE(index);

            const coordinateIndex = coords.length;
            const scale = coordinateIndex < 3 ? 10 : 100;

            coords.push(raw / scale);
        }

        if (coords.length !== 6) {
            return;
        }

        this.sensorData.coords = coords;
        this.sensorData.x = coords[0];
        this.sensorData.y = coords[1];
        this.sensorData.z = coords[2];
        this.sensorData.rx = coords[3];
        this.sensorData.ry = coords[4];
        this.sensorData.rz = coords[5];
    }

    makeStopPacket() {
        return Buffer.from([
            0xfe,
            0xfe,
            0x02,
            0x29,
            0xfa,
        ]);
    }

    makeSetGripperStatePacket(state, speed) {
        const safeState = Number(state) === 1 ? 1 : 0;

        const safeSpeed = Math.max(
            0,
            Math.min(100, Math.trunc(Number(speed)))
        );

        return Buffer.from([
            0xfe,
            0xfe,
            0x04,
            0x66,
            safeState,
            safeSpeed,
            0xfa,
        ]);
    }

    makeSetGripperValuePacket(value, speed) {
        const safeValue = Math.max(
            0,
            Math.min(100, Math.trunc(Number(value)))
        );

        const safeSpeed = Math.max(
            0,
            Math.min(100, Math.trunc(Number(speed)))
        );

        return Buffer.from([
            0xfe,
            0xfe,
            0x04,
            0x67,
            safeValue,
            safeSpeed,
            0xfa,
        ]);
    }

    /**
     * EntryJS에 센서값 전달
     */
    requestRemoteData(handler) {
        handler.write('connected', this.sensorData.connected);
        handler.write('angles', this.sensorData.angles);
        handler.write('coords', this.sensorData.coords);
        handler.write('x', this.sensorData.x);
        handler.write('y', this.sensorData.y);
        handler.write('z', this.sensorData.z);
        handler.write('rx', this.sensorData.rx);
        handler.write('ry', this.sensorData.ry);
        handler.write('rz', this.sensorData.rz);        

        for (let joint = 1; joint <= 6; joint += 1) {
            handler.write(
                `angle${joint}`,
                this.sensorData[`angle${joint}`]
            );
        }
    }

    /**
     * 연결 시 현재 각도 조회 패킷 전송
     */
    requestInitialData() {
        return this.makeGetAnglesPacket();
    }

    /**
     * 초기 응답으로 실제 myCobot인지 확인
     */
    checkInitialData(data) {
        if (!data || data.length < 5) {
            return undefined;
        }

        const buffer = Buffer.from(data);
        const headerIndex = this.findHeader(buffer);

        if (headerIndex < 0 || buffer.length < headerIndex + 5) {
            return undefined;
        }

        const command = buffer[headerIndex + 3];

        // 현재 각도 조회 응답이면 연결 성공
        if (command === 0x20) {
            this.sensorData.connected = true;
            this.handleLocalData(buffer.subarray(headerIndex));
            return true;
        }

        return undefined;
    }

    setSerialPort(serialport) {
        this.serialport = serialport;
    }

    reset() {
        this.commands = [];
        this.receiveBuffer = Buffer.alloc(0);

        this.sensorData = {
            connected: false,

            angles: [0, 0, 0, 0, 0, 0],
            angle1: 0,
            angle2: 0,
            angle3: 0,
            angle4: 0,
            angle5: 0,
            angle6: 0,

            coords: [0, 0, 0, 0, 0, 0],
            x: 0,
            y: 0,
            z: 0,
            rx: 0,
            ry: 0,
            rz: 0,
        };

        this.lastSendTime = 0;
        this.lastPollTime = 0;
        this.lastRemoteCommandKey = null;

        this.pollTarget = 'angles';
    }

    disconnect(connect) {
        this.reset();

        if (connect) {
            connect.close();
        }
    }
}

module.exports = new MyCobot280M5();
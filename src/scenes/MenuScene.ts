export class MenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MenuScene' });
  }

  create() {
    const width = this.cameras.main.width;
    const height = this.cameras.main.height;

    // Title
    this.add.text(width / 2, height / 4, 'ORION', {
      fontSize: '64px',
      color: '#ffffff',
      fontStyle: 'bold'
    }).setOrigin(0.5);

    // Subtitle
    this.add.text(width / 2, height / 3, 'Space Strategy', {
      fontSize: '32px',
      color: '#ffffff'
    }).setOrigin(0.5);

    // Start button
    const startButton = this.add.text(width / 2, height / 2, 'Галактика', {
      fontSize: '32px',
      color: '#ffffff',
      backgroundColor: '#444444',
      padding: { x: 20, y: 10 }
    })
    .setName('start-campaign').setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

    // Ship Test button
    const testButton = this.add.text(width / 2, height / 2 + 60, 'Ship Test', {
      fontSize: '24px',
      color: '#ffffff',
      backgroundColor: '#444444',
      padding: { x: 20, y: 10 }
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

    // Shipyard button
    const shipyardButton = this.add.text(width / 2, height / 2 + 120, 'Shipyard', {
      fontSize: '24px',
      color: '#ffffff',
      backgroundColor: '#226622',
      padding: { x: 20, y: 10 }
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

    // Battle Test button
    const battleButton = this.add.text(width / 2, height / 2 + 180, 'Battle Test', {
      fontSize: '24px',
      color: '#ffffff',
      backgroundColor: '#662222',
      padding: { x: 20, y: 10 }
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

    // Button interactions
    startButton
      .on('pointerover', () => startButton.setStyle({ backgroundColor: '#666666' }))
      .on('pointerout', () => startButton.setStyle({ backgroundColor: '#444444' }))
      .on('pointerdown', () => this.scene.start('MainScene'));
    
    testButton
      .on('pointerover', () => testButton.setStyle({ backgroundColor: '#666666' }))
      .on('pointerout', () => testButton.setStyle({ backgroundColor: '#444444' }))
      .on('pointerdown', () => this.scene.start('ShipTestScene'));

    shipyardButton
      .on('pointerover', () => shipyardButton.setStyle({ backgroundColor: '#338833' }))
      .on('pointerout', () => shipyardButton.setStyle({ backgroundColor: '#226622' }))
      .on('pointerdown', () => this.scene.start('ShipyardScene'));

    battleButton
      .on('pointerover', () => battleButton.setStyle({ backgroundColor: '#882222' }))
      .on('pointerout', () => battleButton.setStyle({ backgroundColor: '#662222' }))
      .on('pointerdown', () => this.scene.start('BattleScene'));
  }
}
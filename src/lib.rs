use bevy::{prelude::*, sprite::MaterialMesh2dBundle, time::FixedTimestep};
use js_sys::Math;
use wasm_bindgen::prelude::*;

// Defines the amount of time that should elapse between each physics step.
const TIME_STEP: f32 = 1.0 / 60.0;

const PADDLE_SPEED: f32 = 500.0;

// #[no_mangle]
// extern "C" fn player_joined(player: u32) {
//     // do something
// }

#[wasm_bindgen(start)]
fn start() {
    App::new()
        .add_plugins(DefaultPlugins)
        .add_startup_system(setup)
        .add_system_set(
            SystemSet::new()
                .with_run_criteria(FixedTimestep::step(TIME_STEP as f64))
                .with_system(move_paddle),
        )
        .run();
}

#[derive(Component)]
struct Paddle;

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<ColorMaterial>>,
) {
    commands.spawn(Camera2dBundle::default());

    let r = Math::random() as f32;
    let g = Math::random() as f32;
    let b = Math::random() as f32;
    commands.spawn((
        SpriteBundle {
            transform: Transform {
                translation: Vec3::new(0.0, 0.0, 0.0),
                ..default()
            },
            sprite: Sprite {
                color: Color::rgb(r, g, b),
                // color: Color::rgb(0.25, 0.25, 0.75),
                custom_size: Some(Vec2::new(50.0, 100.0)),
                ..default()
            },
            ..default()
        },
        Paddle,
    ));

    commands.spawn(MaterialMesh2dBundle {
        mesh: meshes.add(shape::Circle::new(50.).into()).into(),
        material: materials.add(ColorMaterial::from(Color::rgb(r, g, b))),
        transform: Transform::from_translation(Vec3::new(-100., 0., 0.)),
        ..default()
    });

    commands.spawn(MaterialMesh2dBundle {
        mesh: meshes.add(shape::RegularPolygon::new(50., 6).into()).into(),
        material: materials.add(ColorMaterial::from(Color::rgb(r, g, b))),
        transform: Transform::from_translation(Vec3::new(100., 0., 0.)),
        ..default()
    });
}

fn move_paddle(
    keyboard_input: Res<Input<KeyCode>>,
    mut query: Query<&mut Transform, With<Paddle>>,
) {
    let mut paddle_transform = query.single_mut();
    let mut direction = 0.0;

    if keyboard_input.pressed(KeyCode::Left) {
        direction -= 1.0;
    }

    if keyboard_input.pressed(KeyCode::Right) {
        direction += 1.0;
    }

    let new_paddle_position = paddle_transform.translation.x + direction * PADDLE_SPEED * TIME_STEP;
    paddle_transform.translation.x = new_paddle_position;
}
